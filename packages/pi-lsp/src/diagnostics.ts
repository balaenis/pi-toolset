// ABOUTME: Passive LSP diagnostic registry — dedup, throttle, edit-aware cleanup.
// ABOUTME: Port of Claude Code's LSPDiagnosticRegistry, adapted to Pi (internal LRU, text drain).

import { formatUri } from './formatters.ts';
import { errorMessage, logError, logForDebugging } from './log.ts';
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver-types';

/**
 * Maximum diagnostics kept per file after throttling.
 */
const MAX_DIAGNOSTICS_PER_FILE = 10;
/**
 * Maximum total diagnostics delivered in a single drain (across all files).
 */
const MAX_TOTAL_DIAGNOSTICS = 30;
/**
 * Maximum files tracked for cross-turn deduplication. Prevents unbounded memory
 * growth in long sessions. Oldest entries are evicted.
 */
const MAX_DELIVERED_FILES = 500;

type Severity = 'Error' | 'Warning' | 'Info' | 'Hint';

/**
 * Normalized diagnostic stored in the registry. Severity is mapped from the
 * numeric LSP `DiagnosticSeverity` to a string at registration time so dedup
 * and formatting deal with stable values.
 */
interface StoredDiagnostic {
  message: string;
  severity: Severity;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  source?: string;
  code?: string;
}

interface DiagnosticFile {
  uri: string;
  diagnostics: StoredDiagnostic[];
}

/**
 * Minimal LRU map built on Map insertion-order semantics.
 *
 * `get` and `set` of an existing key move it to the most-recent position; when
 * inserting a new key past `max`, the least-recent key is evicted. This is the
 * only data structure needed to keep cross-turn dedup bounded without pulling
 * in a runtime dependency.
 */
class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Move to most-recent: delete then re-insert preserves insertion order.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      // Map iteration is insertion order; first entry is least-recently used.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// Pending diagnostics, keyed by file URI. LSP servers send the full diagnostic
// set for a URI on every publishDiagnostics, so latest-per-URI wins. An empty
// publish clears the entry (the file is now clean).
const pendingDiagnostics = new Map<string, DiagnosticFile>();

// Cross-turn deduplication: maps file URI to the set of diagnostic keys already
// delivered. Bounds memory with a tiny LRU so a long session doesn't grow it.
const deliveredDiagnostics = new LruMap<string, Set<string>>(MAX_DELIVERED_FILES);

function mapSeverity(lspSeverity: number | undefined): Severity {
  // LSP DiagnosticSeverity: 1=Error, 2=Warning, 3=Information, 4=Hint
  switch (lspSeverity) {
    case 1:
      return 'Error';
    case 2:
      return 'Warning';
    case 3:
      return 'Info';
    case 4:
      return 'Hint';
    default:
      return 'Error';
  }
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case 'Error':
      return 1;
    case 'Warning':
      return 2;
    case 'Info':
      return 3;
    case 'Hint':
      return 4;
  }
}

function severitySymbol(severity: Severity): string {
  switch (severity) {
    case 'Error':
      return '✖';
    case 'Warning':
      return '⚠';
    case 'Info':
      return 'ℹ';
    case 'Hint':
      return '·';
  }
}

/**
 * Stable key for a diagnostic used by both within-batch and cross-turn dedup.
 * Two diagnostics are considered duplicates when message, severity, range,
 * source, and code all match.
 */
function diagnosticKey(diag: StoredDiagnostic): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source ?? null,
    code: diag.code ?? null,
  });
}

function toStoredDiagnostic(diag: LspDiagnostic): StoredDiagnostic {
  return {
    // LSP 3.18 allows MarkupContent messages, but we don't advertise
    // markupMessageSupport so servers send strings. Normalize defensively.
    message: typeof diag.message === 'string' ? diag.message : diag.message.value,
    severity: mapSeverity(diag.severity),
    range: {
      start: {
        line: diag.range.start.line,
        character: diag.range.start.character,
      },
      end: {
        line: diag.range.end.line,
        character: diag.range.end.character,
      },
    },
    source: diag.source,
    code: diag.code !== undefined && diag.code !== null ? String(diag.code) : undefined,
  };
}

/**
 * Register diagnostics published by an LSP server for a file URI.
 *
 * Stores the latest diagnostic set for the URI (latest publish wins). An empty
 * diagnostic list clears the pending entry — the file is now clean and should
 * not contribute to the next drain.
 */
export function register(uri: string, diagnostics: LspDiagnostic[]): void {
  if (!uri) {
    logForDebugging('diagnostics.register called with empty URI — ignoring', {
      level: 'warn',
    });
    return;
  }

  if (diagnostics.length === 0) {
    // Clean publish: the file has no diagnostics. Drop any pending entry so we
    // don't deliver stale ones.
    pendingDiagnostics.delete(uri);
    logForDebugging(`diagnostics: cleared pending for ${uri} (clean publish)`);
    return;
  }

  const stored: StoredDiagnostic[] = diagnostics.map(toStoredDiagnostic);
  pendingDiagnostics.set(uri, { uri, diagnostics: stored });
  logForDebugging(`diagnostics: registered ${stored.length} diagnostic(s) for ${uri}`);
}

/**
 * Drain pending diagnostics into a single text block for LLM injection.
 *
 * Deduplicates within the batch and against previously delivered diagnostics
 * (cross-turn), throttles to the configured per-file and total caps (errors
 * first), marks the survivors as delivered, and clears the pending store.
 *
 * @returns Formatted block text, or null when there is nothing new to deliver.
 */
export function drain(cwd?: string): string | null {
  if (pendingDiagnostics.size === 0) {
    return null;
  }

  const files: DiagnosticFile[] = [];
  for (const file of pendingDiagnostics.values()) {
    const previouslyDelivered = deliveredDiagnostics.get(file.uri) ?? new Set();
    const seenThisBatch = new Set<string>();
    const deduped: StoredDiagnostic[] = [];

    for (const diag of file.diagnostics) {
      let key: string;
      try {
        key = diagnosticKey(diag);
      } catch (error) {
        // Should not happen for plain object serialization, but stay robust.
        logError(
          new Error(`diagnostics: failed to build key for ${file.uri}: ${errorMessage(error)}`)
        );
        deduped.push(diag);
        continue;
      }

      if (seenThisBatch.has(key) || previouslyDelivered.has(key)) {
        continue;
      }
      seenThisBatch.add(key);
      deduped.push(diag);
    }

    if (deduped.length > 0) {
      files.push({ uri: file.uri, diagnostics: deduped });
    }
  }

  // Pending entries are consumed by this drain; latest publish wins means the
  // set we just read is the current truth, so clear the store.
  pendingDiagnostics.clear();

  if (files.length === 0) {
    logForDebugging('diagnostics: drain produced no new diagnostics after dedup');
    return null;
  }

  // Throttle: sort each file by severity (Error first), cap per file, then cap
  // the total across files. Files are processed in insertion order so no file
  // starves unless the global cap is hit.
  let total = 0;
  let truncated = 0;
  for (const file of files) {
    file.diagnostics.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    if (file.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
      truncated += file.diagnostics.length - MAX_DIAGNOSTICS_PER_FILE;
      file.diagnostics = file.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
    }

    const remaining = MAX_TOTAL_DIAGNOSTICS - total;
    if (file.diagnostics.length > remaining) {
      truncated += file.diagnostics.length - remaining;
      file.diagnostics = file.diagnostics.slice(0, remaining);
    }
    total += file.diagnostics.length;
  }

  const deliveredFiles = files.filter((f) => f.diagnostics.length > 0);
  if (deliveredFiles.length === 0) {
    return null;
  }

  // Track delivered diagnostics for cross-turn dedup so we don't re-inject the
  // same issue without an edit in between.
  for (const file of deliveredFiles) {
    const delivered = deliveredDiagnostics.get(file.uri) ?? new Set<string>();
    for (const diag of file.diagnostics) {
      try {
        delivered.add(diagnosticKey(diag));
      } catch (error) {
        logError(
          new Error(
            `diagnostics: failed to track delivered for ${file.uri}: ${errorMessage(error)}`
          )
        );
      }
    }
    deliveredDiagnostics.set(file.uri, delivered);
  }

  const totalDelivered = deliveredFiles.reduce((sum, f) => sum + f.diagnostics.length, 0);
  logForDebugging(
    `diagnostics: delivering ${totalDelivered} diagnostic(s) across ${deliveredFiles.length} file(s)` +
      (truncated > 0 ? ` (${truncated} truncated by caps)` : '')
  );

  return formatBlock(deliveredFiles, totalDelivered, truncated, cwd);
}

function formatBlock(
  files: DiagnosticFile[],
  total: number,
  truncated: number,
  cwd?: string
): string {
  const lines: string[] = [
    `New LSP diagnostics detected (${total} issue${total === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}):`,
  ];

  for (const file of files) {
    const filePath = formatUri(file.uri, cwd);
    lines.push('');
    lines.push(`${filePath}:`);
    for (const diag of file.diagnostics) {
      const line = diag.range.start.line + 1;
      const character = diag.range.start.character + 1;
      const symbol = severitySymbol(diag.severity);
      const source = diag.source ? ` (${diag.source})` : '';
      const code = diag.code ? ` [${diag.code}]` : '';
      lines.push(`  ${symbol} [${line}:${character}] ${diag.message}${code}${source}`);
    }
  }

  if (truncated > 0) {
    lines.push('');
    lines.push(`(${truncated} additional diagnostic(s) truncated by volume caps)`);
  }

  return lines.join('\n');
}

/**
 * Clear delivered-diagnostic tracking and any pending entry for a file.
 *
 * Called after the agent edits a file so that fresh diagnostics for it can be
 * shown again even if they match previously delivered ones.
 */
export function clearForFile(uri: string): void {
  if (pendingDiagnostics.has(uri)) {
    pendingDiagnostics.delete(uri);
  }
  if (deliveredDiagnostics.has(uri)) {
    deliveredDiagnostics.delete(uri);
    logForDebugging(`diagnostics: cleared delivered tracking for ${uri}`);
  }
}

/**
 * Reset all diagnostic state. Called on session shutdown so a new session starts
 * clean and no cross-session leakage occurs.
 */
export function resetAll(): void {
  pendingDiagnostics.clear();
  deliveredDiagnostics.clear();
  logForDebugging('diagnostics: reset all state');
}
