// ABOUTME: Unit tests for LSP startup failure classification.
// ABOUTME: Verifies permanent path/config failures and retryable startup failures.

import { describe, expect, it } from 'bun:test';
import {
  attachStartupErrorMetadata,
  classifyStartupFailure,
  type StartupFailureKind,
} from '../src/startup-errors.ts';

function codedError(code: string): NodeJS.ErrnoException {
  const error = new Error(`spawn failed with ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function expectKind(error: unknown, kind: StartupFailureKind, retryable: boolean): void {
  const classification = classifyStartupFailure(error);
  expect(classification.kind).toBe(kind);
  expect(classification.retryable).toBe(retryable);
  expect(classification.reason.length).toBeGreaterThan(0);
}

describe('classifyStartupFailure', () => {
  it('treats missing executables as permanent path failures', () => {
    expectKind(codedError('ENOENT'), 'permanent-path', false);
  });

  it('treats executable permission errors as permanent path failures', () => {
    expectKind(codedError('EACCES'), 'permanent-path', false);
  });

  it('treats invalid option stderr as permanent argument failures', () => {
    const error = attachStartupErrorMetadata(new Error('server exited during startup'), {
      startupStderr: 'error: unknown option --bad-flag',
      phase: 'initialize',
    });

    expectKind(error, 'permanent-arguments', false);
  });

  it('treats initialization configuration text as permanent configuration failures', () => {
    expectKind(
      new Error('initialize failed: invalid initializationOptions.plugins must be an array'),
      'permanent-configuration',
      false
    );
  });

  it('treats startup timeout text as retryable timeout failures', () => {
    expectKind(
      new Error("LSP server 'ts' timed out after 100ms during initialization"),
      'retryable-timeout',
      true
    );
  });

  it('defaults unknown startup failures to retryable', () => {
    expectKind(
      new Error('connection closed before initialize response'),
      'retryable-unknown',
      true
    );
  });
});
