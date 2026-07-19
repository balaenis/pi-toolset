// ABOUTME: Tests for multi-server diagnostic registry behavior.
// ABOUTME: Verifies pending invalidation, cross-edit dedup, and clean-report clearing.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver-types';
import {
  drain,
  formatDiagnosticsState,
  hasDiagnostics,
  invalidatePendingForFile,
  onChanged,
  register,
  resetAll,
} from '../src/diagnostics.ts';

function diag(message: string, source?: string, line = 0): LspDiagnostic {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    message,
    severity: 1,
    source,
  };
}

beforeEach(() => {
  resetAll();
});

afterEach(() => {
  resetAll();
});

describe('multi-server diagnostics', () => {
  it('preserves diagnostics from two servers for the same URI in one drain', () => {
    const uri = 'file:///tmp/a.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    const block = drain();
    expect(block).not.toBeNull();
    expect(block!).toContain('TS error');
    expect(block!).toContain('lint error');
    // Single file section.
    const fileHeadings = block!.split('\n').filter((l) => l.endsWith(':') && !l.startsWith('  '));
    // The header (first line) ends with ':', plus the URI heading; expect at most one URI heading.
    const uriOccurrences = block!.split('\n').filter((l) => l.includes('a.ts:'));
    expect(uriOccurrences.length).toBe(1);
    expect(fileHeadings.length).toBeGreaterThan(0);
  });

  it('clears only the publishing server when an empty publish arrives', () => {
    const uri = 'file:///tmp/b.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    // ESLint publishes an empty set (file now clean from its perspective).
    register('eslint', uri, []);

    const block = drain();
    expect(block).not.toBeNull();
    expect(block!).toContain('TS error');
    expect(block!).not.toContain('lint error');
  });

  it('clears delivered diagnostics for the publishing server on clean publish', () => {
    const uri = 'file:///tmp/b-delivered.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);
    drain();

    expect(formatDiagnosticsState()).toContain('Delivered (2 issues across 1 file)');
    expect(hasDiagnostics()).toBe(true);

    // ESLint reports a clean publish: its delivered tracking should go away.
    register('eslint', uri, []);
    expect(formatDiagnosticsState()).toContain('TS error');
    expect(formatDiagnosticsState()).not.toContain('lint error');
    expect(hasDiagnostics()).toBe(true);

    // Once TypeScript also reports clean, nothing should remain.
    register('typescript', uri, []);
    expect(formatDiagnosticsState()).toBe(
      'LSP diagnostics\n\nNo pending or delivered diagnostics.'
    );
    expect(hasDiagnostics()).toBe(false);
  });

  it('keeps identical messages from different servers as separate diagnostics', () => {
    const uri = 'file:///tmp/c.ts';
    // Same message text but different originating servers must not be deduped.
    register('typescript', uri, [diag('shared message', undefined, 5)]);
    register('eslint', uri, [diag('shared message', undefined, 5)]);

    const block = drain();
    expect(block).not.toBeNull();
    // Both should appear; the formatter tags them with the server name when
    // `source` is absent.
    expect(block!.match(/shared message/g)?.length ?? 0).toBe(2);
    expect(block!).toContain('server: typescript');
    expect(block!).toContain('server: eslint');
  });

  it('invalidatePendingForFile removes pending entries from every server for that URI', () => {
    const uri = 'file:///tmp/d.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    invalidatePendingForFile(uri);

    expect(drain()).toBeNull();
    expect(hasDiagnostics()).toBe(false);
  });

  it('suppresses unchanged diagnostics across pending invalidation after delivery', () => {
    const uri = 'file:///tmp/e.ts';
    const issue = diag('unchanged error', 'ts', 3);

    register('typescript', uri, [issue]);
    expect(drain()).not.toBeNull();

    // Edit invalidates pending only; delivered keys remain for cross-turn dedup.
    invalidatePendingForFile(uri);
    register('typescript', uri, [issue]);
    expect(drain()).toBeNull();

    // Clean publish from the same server clears that server's delivered keys.
    register('typescript', uri, []);
    register('typescript', uri, [issue]);
    const reintroduced = drain();
    expect(reintroduced).not.toBeNull();
    expect(reintroduced!).toContain('unchanged error');
  });

  it('clean publish clears delivered keys only for the publishing server', () => {
    const uri = 'file:///tmp/f.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);
    drain();

    // Only TypeScript reports clean; ESLint delivered keys stay.
    register('typescript', uri, []);

    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    const block = drain();
    expect(block).not.toBeNull();
    expect(block!).toContain('TS error');
    expect(block!).not.toContain('lint error');
  });
});

describe('diagnostic presence indicator', () => {
  it('reflects pending and delivered state', () => {
    expect(hasDiagnostics()).toBe(false);

    register('ts', 'file:///x.ts', [diag('e')]);
    expect(hasDiagnostics()).toBe(true);

    drain();
    expect(hasDiagnostics()).toBe(true);

    // Pending invalidation must not clear delivered presence.
    invalidatePendingForFile('file:///x.ts');
    expect(hasDiagnostics()).toBe(true);

    // Clean publish clears the final state.
    register('ts', 'file:///x.ts', []);
    expect(hasDiagnostics()).toBe(false);
  });

  it('clears presence on resetAll after delivery', () => {
    register('ts', 'file:///x.ts', [diag('e')]);
    drain();
    expect(hasDiagnostics()).toBe(true);
    resetAll();
    expect(hasDiagnostics()).toBe(false);
  });

  it('notifies onChanged only on the empty <-> non-empty transition', () => {
    const calls: number[] = [];
    let n = 0;
    const off = onChanged(() => calls.push(++n));

    register('ts', 'file:///x.ts', [diag('e')]);
    expect(calls).toEqual([1]);

    register('ts', 'file:///x.ts', [diag('e2')]);
    expect(calls).toEqual([1]);

    register('ts', 'file:///x.ts', []);
    expect(calls).toEqual([1, 2]);

    off();
  });

  it('does not notify when drain moves pending to delivered', () => {
    const calls: number[] = [];
    const off = onChanged(() => calls.push(1));

    register('ts', 'file:///x.ts', [diag('e')]);
    calls.length = 0;

    drain();
    expect(calls).toEqual([]);
    expect(hasDiagnostics()).toBe(true);

    off();
  });

  it('does not notify when invalidatePendingForFile leaves delivered state', () => {
    const calls: number[] = [];
    const off = onChanged(() => calls.push(1));

    register('ts', 'file:///x.ts', [diag('e')]);
    drain();
    calls.length = 0;

    invalidatePendingForFile('file:///x.ts');
    expect(calls).toEqual([]);
    expect(hasDiagnostics()).toBe(true);

    off();
  });
});

describe('formatDiagnosticsState', () => {
  it('reports no diagnostics when empty', () => {
    expect(formatDiagnosticsState()).toBe(
      'LSP diagnostics\n\nNo pending or delivered diagnostics.'
    );
  });

  it('shows pending diagnostics', () => {
    register('ts', 'file:///x.ts', [diag('pending error', 'ts', 2)]);
    const output = formatDiagnosticsState();
    expect(output).toContain('Pending (1 issue across 1 file):');
    expect(output).toContain('x.ts:');
    expect(output).toContain('pending error');
    expect(output).toContain('[3:1]');
    expect(output).not.toContain('Delivered');
  });

  it('shows delivered diagnostics after drain', () => {
    register('ts', 'file:///x.ts', [diag('delivered error', 'ts', 4)]);
    drain();
    const output = formatDiagnosticsState();
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('delivered error');
    expect(output).toContain('[5:1]');
    expect(output).not.toContain('Pending');
  });

  it('groups multiple servers for the same file', () => {
    register('ts', 'file:///x.ts', [diag('ts error', 'ts', 0)]);
    register('eslint', 'file:///x.ts', [diag('lint error', 'eslint', 1)]);
    const output = formatDiagnosticsState();
    expect(output).toContain('Pending (2 issues across 1 file):');
    const uriOccurrences = output.split('\n').filter((l) => l.includes('x.ts:'));
    expect(uriOccurrences.length).toBe(1);
  });

  it('keeps delivered diagnostics after pending invalidation', () => {
    const uri = 'file:///x.ts';
    register('ts', uri, [diag('e')]);
    drain();
    invalidatePendingForFile(uri);
    const output = formatDiagnosticsState();
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('e');
    expect(output).not.toContain('Pending');
  });

  it('shows the originating server for delivered diagnostics without a source', () => {
    // No `source` on the diagnostic — formatter must still tag the line with
    // the originating server after the delivered key round-trip.
    register('eslint', 'file:///x.ts', [diag('no-source error', undefined, 3)]);
    drain();
    const output = formatDiagnosticsState();
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('no-source error');
    expect(output).toContain('server: eslint');
  });

  it('preserves the diagnostic code through delivered-key parsing', () => {
    const withCode: LspDiagnostic = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      message: 'coded error',
      severity: 1,
      source: 'ts',
      code: 2322,
    };
    register('ts', 'file:///x.ts', [withCode]);
    drain();
    const output = formatDiagnosticsState();
    expect(output).toContain('coded error');
    expect(output).toContain('[2322]');
  });

  it('shows pending and delivered sections for the same file', () => {
    const uri = 'file:///x.ts';
    register('ts', uri, [diag('first', 'ts', 0)]);
    drain();
    register('ts', uri, [diag('second', 'ts', 1)]);
    const output = formatDiagnosticsState();
    expect(output).toContain('Pending (1 issue across 1 file):');
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('first');
    expect(output).toContain('second');
    expect(output.indexOf('Pending')).toBeLessThan(output.indexOf('Delivered'));
  });
});
