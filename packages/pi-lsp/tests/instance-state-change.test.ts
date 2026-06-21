// ABOUTME: Tests that LSPServerInstance fires onStateChange on every transition.
// ABOUTME: Uses an injectable fake LSP client so no real child process is needed.

import { describe, expect, it } from 'bun:test';
import type { InitializeParams, InitializeResult } from 'vscode-languageserver-protocol';
import type { LSPClient } from '../src/client.ts';
import { createLSPServerInstance, type LSPClientFactory } from '../src/instance.ts';
import type { LspServerState, ScopedLspServerConfig } from '../src/types.ts';

function baseConfig(overrides: Partial<ScopedLspServerConfig> = {}): ScopedLspServerConfig {
  return {
    command: 'fake-lsp',
    args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript' },
    workspaceFolder: process.cwd(),
    startupTimeout: 1000,
    maxRestarts: 3,
    ...overrides,
  };
}

type Outcome = 'success' | Error;

function makeFactory(outcomes: Outcome[]): {
  factory: LSPClientFactory;
  triggerCrash(error: Error): void;
} {
  let initialized = false;
  let crashHandler: ((error: Error) => void) | undefined;

  const factory: LSPClientFactory = (_name, onCrash) => {
    crashHandler = onCrash;
    const client: LSPClient = {
      get capabilities() {
        return initialized ? {} : undefined;
      },
      get isInitialized() {
        return initialized;
      },
      async start() {},
      async initialize(_params: InitializeParams): Promise<InitializeResult> {
        const outcome = outcomes.shift() ?? 'success';
        if (outcome instanceof Error) {
          throw outcome;
        }
        initialized = true;
        return { capabilities: {} };
      },
      async sendRequest() {
        return undefined as never;
      },
      async sendNotification() {},
      onNotification() {},
      onRequest() {},
      async stop() {
        initialized = false;
      },
    };
    return client;
  };

  return {
    factory,
    triggerCrash(error: Error) {
      if (!crashHandler) throw new Error('no crash handler captured');
      crashHandler(error);
    },
  };
}

describe('LSPServerInstance onStateChange', () => {
  it('fires for the starting → running success path', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await server.start();
    expect(transitions).toEqual(['starting', 'running']);
  });

  it('fires for the starting → error startup-failure path', async () => {
    const harness = makeFactory([new Error('connection closed before initialize response')]);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await expect(server.start()).rejects.toThrow();
    expect(transitions).toEqual(['starting', 'error']);
  });

  it('fires running → stopping → stopped on stop()', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await server.start();
    await server.stop();
    expect(transitions).toEqual(['starting', 'running', 'stopping', 'stopped']);
  });

  it('fires running → error when the client emits an unexpected crash', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance(
      'typescript',
      baseConfig({ restartOnCrash: false }),
      harness.factory,
      (state) => transitions.push(state)
    );

    await server.start();
    expect(transitions).toEqual(['starting', 'running']);

    harness.triggerCrash(new Error('child exited unexpectedly'));
    expect(transitions).toEqual(['starting', 'running', 'error']);
    expect(server.state).toBe('error');
  });

  it('does not refire when the same state is set twice', async () => {
    const harness = makeFactory(['success']);
    const transitions: LspServerState[] = [];
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory, (state) =>
      transitions.push(state)
    );

    await server.start();
    // Second start() call returns immediately; state stays running.
    await server.start();
    expect(transitions).toEqual(['starting', 'running']);
  });
});
