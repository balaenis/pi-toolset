// ABOUTME: Lifecycle tests for startup retry policy on LSP server instances.
// ABOUTME: Uses an injectable fake LSP client to avoid spawning real language servers.

import { describe, expect, it } from 'bun:test';
import type { InitializeParams, InitializeResult } from 'vscode-languageserver-protocol';
import { createLSPServerInstance, type LSPClientFactory } from '../src/instance.ts';
import type { LSPClient } from '../src/client.ts';
import type { ScopedLspServerConfig } from '../src/types.ts';

type Outcome = 'success' | 'deferred-success' | Error;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function baseConfig(maxRestarts = 3): ScopedLspServerConfig {
  return {
    command: 'fake-lsp',
    args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript' },
    workspaceFolder: process.cwd(),
    startupTimeout: 1000,
    maxRestarts,
  };
}

function codedError(code: string): NodeJS.ErrnoException {
  const error = new Error(`spawn fake-lsp ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function makeFactory(outcomes: Outcome[]): {
  factory: LSPClientFactory;
  getStartCount: () => number;
  getInitializeCount: () => number;
  deferredInitialize?: Deferred<InitializeResult>;
} {
  let startCount = 0;
  let initializeCount = 0;
  let initialized = false;
  let deferredInitialize: Deferred<InitializeResult> | undefined;

  const factory: LSPClientFactory = () => {
    const client: LSPClient = {
      get capabilities() {
        return initialized ? {} : undefined;
      },
      get isInitialized() {
        return initialized;
      },
      async start() {
        startCount++;
      },
      async initialize(_params: InitializeParams) {
        initializeCount++;
        const outcome = outcomes.shift() ?? 'success';
        if (outcome instanceof Error) {
          throw outcome;
        }
        if (outcome === 'deferred-success') {
          deferredInitialize = deferred<InitializeResult>();
          const result = await deferredInitialize.promise;
          initialized = true;
          return result;
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
    getStartCount: () => startCount,
    getInitializeCount: () => initializeCount,
    get deferredInitialize() {
      return deferredInitialize;
    },
  };
}

describe('LSP startup retry policy', () => {
  it('blocks permanent spawn/path failures after one startup attempt', async () => {
    const harness = makeFactory([codedError('ENOENT')]);
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory);

    await expect(server.start()).rejects.toThrow('not retrying because the executable');
    expect(harness.getStartCount()).toBe(1);
    expect(server.state).toBe('error');

    await expect(server.start()).rejects.toThrow('not retrying because the executable');
    expect(harness.getStartCount()).toBe(1);
  });

  it('retries unknown startup failures up to maxRestarts then blocks without new attempts', async () => {
    const harness = makeFactory([
      new Error('connection closed before initialize response'),
      new Error('connection closed before initialize response'),
    ]);
    const server = createLSPServerInstance('typescript', baseConfig(2), harness.factory);

    await expect(server.start()).rejects.toThrow('startup failure was not recognized as permanent');
    await expect(server.start()).rejects.toThrow('startup failure was not recognized as permanent');
    expect(harness.getStartCount()).toBe(2);

    await expect(server.start()).rejects.toThrow('startup retry limit exceeded after 2 attempt');
    expect(harness.getStartCount()).toBe(2);
  });

  it('clears retryable startup failure state after a successful retry', async () => {
    const harness = makeFactory([
      new Error('connection closed before initialize response'),
      'success',
    ]);
    const server = createLSPServerInstance('typescript', baseConfig(3), harness.factory);

    await expect(server.start()).rejects.toThrow('startup failure was not recognized as permanent');
    expect(server.state).toBe('error');

    await server.start();
    expect(server.state).toBe('running');
    expect(server.lastError).toBeUndefined();
    expect(server.isHealthy()).toBe(true);
    expect(harness.getStartCount()).toBe(2);

    await server.start();
    expect(harness.getStartCount()).toBe(2);
  });

  it('waits for failed-start cleanup before allowing retry attempts', async () => {
    const cleanup = deferred<void>();
    let startCount = 0;
    let initializeCount = 0;
    let stopCount = 0;
    let initialized = false;
    let shouldFail = true;

    const factory: LSPClientFactory = () => ({
      get capabilities() {
        return initialized ? {} : undefined;
      },
      get isInitialized() {
        return initialized;
      },
      async start() {
        startCount++;
      },
      async initialize() {
        initializeCount++;
        if (shouldFail) {
          shouldFail = false;
          throw new Error('connection closed before initialize response');
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
        stopCount++;
        await cleanup.promise;
        initialized = false;
      },
    });

    const server = createLSPServerInstance('typescript', baseConfig(3), factory);
    const firstResult = server.start().then(
      () => undefined,
      (error) => error as Error
    );

    await flushMicrotasks();
    expect(stopCount).toBe(1);

    const secondResult = server.start().then(
      () => undefined,
      (error) => error as Error
    );

    await flushMicrotasks();
    expect(startCount).toBe(1);
    expect(initializeCount).toBe(1);

    cleanup.resolve(undefined);

    const firstError = await firstResult;
    const secondError = await secondResult;
    expect(firstError?.message).toContain('startup failure was not recognized as permanent');
    expect(secondError?.message).toContain('startup failure was not recognized as permanent');

    await server.start();
    expect(server.state).toBe('running');
    expect(server.isHealthy()).toBe(true);
    expect(startCount).toBe(2);
    expect(initializeCount).toBe(2);
  });

  it('shares one in-flight startup attempt across concurrent callers', async () => {
    const harness = makeFactory(['deferred-success']);
    const server = createLSPServerInstance('typescript', baseConfig(), harness.factory);

    const first = server.start();
    const second = server.start();

    await Promise.resolve();
    expect(harness.getStartCount()).toBe(1);
    expect(harness.getInitializeCount()).toBe(1);

    harness.deferredInitialize?.resolve({ capabilities: {} });
    await Promise.all([first, second]);

    expect(server.state).toBe('running');
    expect(harness.getStartCount()).toBe(1);
  });
});
