// ABOUTME: Pure remote @ file-completion: parses at-prefixes, builds suggestions from an injected remote lister, wraps providers.
// ABOUTME: No SSH or child processes here; the lister and SSH state are injected by the wiring in index.ts.
import path from 'node:path';
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui';
import type { AutocompleteProviderFactory } from '@earendil-works/pi-coding-agent';

export const REMOTE_AT_MAX_RESULTS = 20;

export interface RemoteFileEntry {
  relativePath: string;
  isDirectory: boolean;
}

export interface ListRemoteFilesRequest {
  searchRoot: string;
  query: string;
  signal: AbortSignal;
}

export type ListRemoteFiles = (request: ListRemoteFilesRequest) => Promise<RemoteFileEntry[]>;

// Derived from pi-tui PATH_DELIMITERS; quoted @"… prefixes are out of scope v1 and delegate to current.
const AT_DELIMITERS = new Set([' ', '\t', '"', "'", '=']);

function extractAtPrefix(text: string): string | null {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (AT_DELIMITERS.has(text[i]!)) {
      const token = text.slice(i + 1);
      if (token.startsWith('@') && !token.startsWith('@"')) return token;
      return null;
    }
  }
  const whole = text;
  return whole.startsWith('@') && !whole.startsWith('@"') ? whole : null;
}

// Directory candidates for drill-down: every proper ancestor segment of each listed file
// (plan option b). Derived once per request by the lister; no extra find round-trip.
export function deriveDirectoriesFromFiles(relativePaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const raw of relativePaths) {
    const rel = raw.replace(/^\.\//, '').replace(/\\/g, '/');
    let slash = rel.lastIndexOf('/');
    while (slash > 0) {
      dirs.add(rel.slice(0, slash));
      slash = rel.lastIndexOf('/', slash - 1);
    }
  }
  return [...dirs];
}

export interface RemoteAtAutocompleteFactoryOptions {
  getSsh: () => { remoteCwd: string } | null;
  localCwd: string;
  listRemoteFiles: ListRemoteFiles;
}

// Wraps the current provider: SSH + unquoted @ token → remote suggestions; anything else delegates.
export function createRemoteAtAutocompleteFactory(
  options: RemoteAtAutocompleteFactoryOptions
): AutocompleteProviderFactory {
  return (current: AutocompleteProvider): AutocompleteProvider => {
    return {
      async getSuggestions(
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        opts: { signal: AbortSignal; force?: boolean }
      ): Promise<AutocompleteSuggestions | null> {
        const ssh = options.getSsh();
        const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
        const atPrefix = extractAtPrefix(textBeforeCursor);
        if (!ssh || !atPrefix) {
          return current.getSuggestions(lines, cursorLine, cursorCol, opts);
        }
        const items = await getRemoteAtSuggestions(atPrefix, {
          localCwd: options.localCwd,
          remoteCwd: ssh.remoteCwd,
          listRemoteFiles: options.listRemoteFiles,
          signal: opts.signal,
        });
        if (items.length === 0) return null;
        return { items, prefix: atPrefix };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    };
  };
}

export interface RemoteAtSuggestionOptions {
  localCwd: string;
  remoteCwd: string;
  signal: AbortSignal;
  listRemoteFiles: ListRemoteFiles;
  maxResults?: number;
}

// Mirrors pi-tui scoreEntry: exact filename, prefix, filename substring, then path substring; dirs get a bonus.
function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
  const fileName = path.basename(filePath);
  const lowerFileName = fileName.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerFileName === lowerQuery) score = 100;
  else if (lowerFileName.startsWith(lowerQuery)) score = 80;
  else if (lowerFileName.includes(lowerQuery)) score = 50;
  else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;
  if (isDirectory && score > 0) score += 10;
  return score;
}

// Splits an at-prefix (e.g. "@src/a") into the remote search root and the fuzzy query.
// Relative prefixes resolve under remoteCwd; absolute prefixes map localCwd→remoteCwd
// via path.resolve (pure remote-absolute paths pass through unchanged).
function parseAtPrefix(atPrefix: string, localCwd: string, remoteCwd: string) {
  const raw = atPrefix.slice(1).replace(/\\/g, '/');
  const slashIndex = raw.lastIndexOf('/');
  const query = slashIndex === -1 ? raw : raw.slice(slashIndex + 1);
  const rawBase = slashIndex === -1 ? '' : raw.slice(0, slashIndex + 1);
  const resolveRemote = (p: string) => path.resolve(localCwd, p).replace(localCwd, remoteCwd);
  const displayBase = rawBase.startsWith('/')
    ? resolveRemote(rawBase) === '/'
      ? '/'
      : `${resolveRemote(rawBase)}/`
    : rawBase;
  return { searchRoot: resolveRemote(rawBase), query, displayBase };
}

export async function getRemoteAtSuggestions(
  atPrefix: string,
  options: RemoteAtSuggestionOptions
): Promise<AutocompleteItem[]> {
  if (options.signal.aborted) return [];
  const { searchRoot, query, displayBase } = parseAtPrefix(
    atPrefix,
    options.localCwd,
    options.remoteCwd
  );
  let entries: RemoteFileEntry[];
  try {
    entries = await options.listRemoteFiles({ searchRoot, query, signal: options.signal });
  } catch {
    return [];
  }
  if (options.signal.aborted) return [];
  const maxResults = options.maxResults ?? REMOTE_AT_MAX_RESULTS;
  return entries
    .map((entry) => ({
      ...entry,
      relativePath: entry.relativePath.replace(/\\/g, '/').replace(/\/+$/, ''),
      score: query ? scoreEntry(entry.relativePath, query, entry.isDirectory) : 1,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((entry) => {
      const displayPath = `${displayBase}${entry.relativePath}`;
      return {
        value: `@${displayPath}${entry.isDirectory ? '/' : ''}`,
        label: `${path.basename(entry.relativePath)}${entry.isDirectory ? '/' : ''}`,
        description: displayPath,
      };
    });
}
