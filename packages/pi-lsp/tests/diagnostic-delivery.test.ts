// ABOUTME: Tests durable diagnostic message construction from registry drains.
// ABOUTME: Covers custom-type shape, empty drains, and one-shot drain behavior.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver-types';
import { DIAGNOSTIC_CUSTOM_TYPE, drainDiagnosticMessage } from '../src/diagnostic-delivery.ts';
import { register, resetAll } from '../src/diagnostics.ts';

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

describe('drainDiagnosticMessage', () => {
  it('builds one hidden durable custom message from a registered diagnostic', () => {
    const cwd = '/tmp/project';
    register('typescript', 'file:///tmp/project/src/app.ts', [
      diag("Type 'string' is not assignable to type 'number'.", 'ts', 4),
    ]);

    const message = drainDiagnosticMessage(cwd);
    expect(message).toBeDefined();
    expect(message!.customType).toBe(DIAGNOSTIC_CUSTOM_TYPE);
    expect(message!.display).toBe(false);
    expect(message!.details).toEqual({ source: 'pi-lsp' });
    expect(typeof message!.content).toBe('string');
    expect(message!.content).toContain('src/app.ts');
    expect(message!.content).toContain("Type 'string' is not assignable to type 'number'.");
  });

  it('returns undefined when there are no pending diagnostics', () => {
    expect(drainDiagnosticMessage('/tmp/project')).toBeUndefined();
  });

  it('returns undefined on a second call after a successful drain', () => {
    const cwd = '/tmp/project';
    register('typescript', 'file:///tmp/project/a.ts', [diag('first error', 'ts', 0)]);

    expect(drainDiagnosticMessage(cwd)).toBeDefined();
    expect(drainDiagnosticMessage(cwd)).toBeUndefined();
  });
});
