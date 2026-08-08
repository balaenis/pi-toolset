// ABOUTME: Verifies pi-remote lifecycle wiring: session-scoped SSH connection ownership, lazy pathless startup, shutdown.
// ABOUTME: Lifecycle tests inject a fake connection factory; the default-export test uses the real factory without live SSH.
import { describe, expect, it, mock } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  default as registerPiRemoteDefault,
  registerPiRemote,
  type PiRemoteDependencies,
} from '../src/index.ts';
import type { SshChildProcess } from '../src/ssh.ts';
import { FakeChild } from './helpers/fake-child.ts';

class FakeSshConnection {
  readonly remote: string;
  readonly controlPath: string;
  spawnCalls: { command: string }[] = [];
  children: FakeChild[] = [];
  closeCalls = 0;
  private closeError: Error | null = null;
  private deferredClose = false;
  private finish: (() => void) | null = null;
  constructor(remote: string) {
    this.remote = remote;
    this.controlPath = `/tmp/pi-test-conn-${encodeURIComponent(remote)}`;
  }
  spawn(command: string) {
    this.spawnCalls.push({ command });
    const child = new FakeChild();
    this.children.push(child);
    return child as unknown as SshChildProcess;
  }
  failClose(error: Error) {
    this.closeError = error;
  }
  deferClose() {
    this.deferredClose = true;
  }
  finishClose() {
    this.finish?.();
    this.finish = null;
  }
  close() {
    this.closeCalls++;
    if (this.deferredClose) {
      return new Promise<void>((resolve) => {
        this.finish = resolve;
      });
    }
    return this.closeError ? Promise.reject(this.closeError) : Promise.resolve();
  }
}

function makePi(flags: Record<string, string | boolean> = {}) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const tools: unknown[] = [];
  const ui = {
    notifications: [] as { message: string; kind: string }[],
    statuses: [] as { key: string; text: string }[],
    providers: [] as unknown[],
    theme: { fg: (_kind: string, text: string) => text },
    notify: (message: string, kind: string) => {
      ui.notifications.push({ message, kind });
    },
    setStatus: (key: string, text: string) => {
      ui.statuses.push({ key, text });
    },
    addAutocompleteProvider: (factory: unknown) => {
      ui.providers.push(factory);
    },
  };
  const pi = {
    registerFlag: mock((_name: string, _options: unknown) => {}),
    getFlag: mock((name: string) => flags[name]),
    registerTool: mock((tool: unknown) => {
      tools.push(tool);
    }),
    on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
      (handlers[event] ??= []).push(handler);
    }),
  };
  return { pi, handlers, ui, tools, ctx: { ui } };
}

function makeHarness(flag: string) {
  const { pi, handlers, ui, tools, ctx } = makePi({ ssh: flag });
  const connections: FakeSshConnection[] = [];
  const createSshConnection = mock((remote: string) => {
    const conn = new FakeSshConnection(remote);
    connections.push(conn);
    return Promise.resolve(conn);
  }) as unknown as PiRemoteDependencies['createSshConnection'];
  const getTool = (name: string) => {
    const tool = tools.find((t) => (t as { name?: string }).name === name);
    if (!tool) throw new Error(`registered tool not found: ${name}`);
    return tool;
  };
  registerPiRemote(pi as unknown as ExtensionAPI, { createSshConnection });
  return { pi, handlers, ui, tools, ctx, connections, createSshConnection, getTool };
}

describe('registerPiRemote session lifecycle', () => {
  it('defers SSH setup to the session lifecycle', async () => {
    const { handlers, ui, ctx, connections, createSshConnection } =
      makeHarness('user@host:/remote/path');

    expect(createSshConnection).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);

    const startHandler = handlers.session_start![0]!;
    await startHandler({}, ctx);

    expect(connections).toHaveLength(1);
    const conn = connections[0]!;
    expect(conn.remote).toBe('user@host');
    expect(conn.spawnCalls).toHaveLength(0);
    expect(ui.providers).toHaveLength(1);
    const status = ui.statuses.find((s) => s.key === 'ssh')!;
    expect(status.text).toContain('user@host');
    expect(status.text).toContain('/remote/path');

    const bashResult = handlers.user_bash![0]!({}, ctx) as {
      operations: {
        exec: (
          command: string,
          cwd: string,
          options: { onData: (d: Buffer) => void }
        ) => Promise<{ exitCode: number | null }>;
      };
    };
    const data: Buffer[] = [];
    const execPromise = bashResult.operations.exec('echo hi', process.cwd(), {
      onData: (d) => data.push(d),
    });
    conn.children[0]!.stdout.write('hello');
    conn.children[0]!.emit('close', 0);
    const execResult = await execPromise;

    expect(execResult.exitCode).toBe(0);
    expect(data.map((d) => d.toString()).join('')).toBe('hello');
    expect(conn.spawnCalls[0]!.command).toBe('cd "/remote/path" && echo hi');

    const shutdownHandler = handlers.session_shutdown![0]!;
    await shutdownHandler({}, ctx);
    await shutdownHandler({}, ctx);
    expect(conn.closeCalls).toBe(1);

    expect(handlers.user_bash![0]!({}, ctx)).toBeUndefined();
  });

  it('exposes no remote operations while shutdown cleanup is pending', async () => {
    const { handlers, ctx, connections } = makeHarness('user@host:/remote/path');
    const startHandler = handlers.session_start![0]!;
    await startHandler({}, ctx);

    const conn = connections[0]!;
    conn.deferClose();
    const shutdownHandler = handlers.session_shutdown![0]!;
    const shutdown1 = shutdownHandler({}, ctx);
    const shutdown2 = shutdownHandler({}, ctx);
    try {
      expect(handlers.user_bash![0]!({}, ctx)).toBeUndefined();
      expect(conn.closeCalls).toBe(1);
    } finally {
      conn.finishClose();
    }
    await Promise.all([shutdown1, shutdown2]);
    expect(conn.closeCalls).toBe(1);
  });

  it('keeps failed SSH startup loud and closes its connection', async () => {
    await assertFailedPathlessStartup();
  });

  it('reports the original SSH failure when cleanup also fails', async () => {
    await assertFailedPathlessStartup(new Error('cleanup failed'));
  });

  it('default export creates and cleans a real SSH connection', async () => {
    const originalXdg = process.env.XDG_RUNTIME_DIR;
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'pi-default-export-'));
    await chmod(runtimeRoot, 0o700);
    let shutdownHandler: ((...args: unknown[]) => unknown) | null = null;
    try {
      process.env.XDG_RUNTIME_DIR = runtimeRoot;
      const { pi, handlers, ctx } = makePi({ ssh: 'user@host:/remote/path' });
      registerPiRemoteDefault(pi as unknown as ExtensionAPI);

      const startHandler = handlers.session_start![0]!;
      await startHandler({}, ctx);
      shutdownHandler = handlers.session_shutdown![0]!;

      // The real factory creates a private mode-0700 runtime dir before any SSH spawn.
      const entries = await readdir(runtimeRoot);
      const privateDirs = entries.filter((e) => e.startsWith('pi-r-'));
      expect(privateDirs).toHaveLength(1);
      expect((await stat(path.join(runtimeRoot, privateDirs[0]!))).mode & 0o777).toBe(0o700);

      await shutdownHandler({}, ctx);
      expect(await readdir(runtimeRoot)).toEqual([]);
    } finally {
      if (shutdownHandler) {
        try {
          await shutdownHandler({}, {});
        } catch {
          // Cleanup is best-effort on assertion failure.
        }
      }
      if (originalXdg === undefined) {
        delete process.env.XDG_RUNTIME_DIR;
      } else {
        process.env.XDG_RUNTIME_DIR = originalXdg;
      }
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

async function assertFailedPathlessStartup(cleanupError?: Error) {
  const { handlers, ui, tools, ctx, connections } = makeHarness('user@host');
  const startHandler = handlers.session_start![0]!;
  const startPromise = startHandler({}, ctx);
  await Promise.resolve();

  const conn = connections[0]!;
  if (cleanupError) conn.failClose(cleanupError);
  const child = conn.children[0]!;
  child.stderr.write('Permission denied');
  child.emit('close', 255);
  await startPromise;

  expect(conn.spawnCalls.map((c) => c.command)).toEqual(['pwd']);
  expect(conn.closeCalls).toBe(1);
  expect(ui.providers).toHaveLength(0);
  const status = ui.statuses.find((s) => s.key === 'ssh')!;
  expect(status.text).toContain('user@host');
  const errorNotify = ui.notifications.find((n) => n.kind === 'error')!;
  expect(errorNotify.message).toContain('SSH failed (255): Permission denied');
  if (cleanupError) {
    expect(errorNotify.message).not.toContain(cleanupError.message);
  }

  const readTool = tools[0] as {
    execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown) => Promise<unknown>;
  };
  await expect(readTool.execute('id', {}, undefined, undefined)).rejects.toThrow(
    'SSH mode unavailable: SSH failed (255): Permission denied'
  );
}

type ToolExecute = (
  id: string,
  params: { path: string; pattern?: string; limit?: number },
  signal: unknown,
  onUpdate: unknown
) => Promise<unknown>;

async function captureError(promise: Promise<unknown>): Promise<Error> {
  const settled = await promise.then(
    () => null,
    (error: unknown) => error
  );
  return settled as Error;
}

async function assertMissingPathRule(scenario: MissingPathScenario): Promise<void> {
  const { handlers, ctx, connections, getTool } = makeHarness('user@host:/remote/path');
  await handlers.session_start![0]!({}, ctx);
  const conn = connections[0]!;
  const tool = getTool(scenario.toolName) as { execute: ToolExecute };

  const transport = tool.execute('missing-path-transport', scenario.input, undefined, undefined);
  const transportChild = conn.children[0]!;
  transportChild.stderr.write(scenario.transportStderr);
  transportChild.emit('close', 255);
  const transportError = await captureError(transport);
  expect(transportError.message).toBe(scenario.expectedTransportError);
  expect(transportError.message).not.toContain('Path not found');
  expect(conn.spawnCalls).toHaveLength(1);
  expect(conn.spawnCalls[0]!.command.startsWith('test -e ')).toBe(true);

  const missing = tool.execute(
    'missing-path-not-found',
    { ...scenario.input, path: 'missing' },
    undefined,
    undefined
  );
  const missingChild = conn.children[1]!;
  missingChild.emit('close', 1);
  const missingError = await captureError(missing);
  expect(missingError.message).toContain('Path not found: ');
  expect(missingError.message).toContain(path.resolve(process.cwd(), 'missing'));
  expect(conn.spawnCalls).toHaveLength(2);
  for (const call of conn.spawnCalls) {
    expect(call.command.includes(scenario.forbiddenFollowUpCommand)).toBe(false);
  }
}

type MissingPathScenario = {
  toolName: 'ls' | 'find';
  input: { path: string; pattern?: string };
  forbiddenFollowUpCommand: string;
  transportStderr: string;
  expectedTransportError: string;
};

const missingPathScenarios: MissingPathScenario[] = [
  {
    toolName: 'ls',
    input: { path: 'lost' },
    forbiddenFollowUpCommand: 'ls -1A',
    transportStderr: 'Connection reset',
    expectedTransportError: 'SSH failed (255): Connection reset',
  },
  {
    toolName: 'find',
    input: { pattern: '*.ts', path: 'lost' },
    forbiddenFollowUpCommand: 'rg --files',
    transportStderr: 'Broken pipe',
    expectedTransportError: 'SSH failed (255): Broken pipe',
  },
];

describe('registerPiRemote missing-path rule', () => {
  for (const scenario of missingPathScenarios) {
    it(`${scenario.toolName} treats only test status 1 as a missing path`, async () => {
      await assertMissingPathRule(scenario);
    });
  }

  it('ls propagates SSH process errors', async () => {
    const { handlers, ctx, connections, getTool } = makeHarness('user@host:/remote/path');
    await handlers.session_start![0]!({}, ctx);
    const conn = connections[0]!;
    const lsTool = getTool('ls') as { execute: ToolExecute };

    const processError = lsTool.execute(
      'ls-process-error',
      { path: 'broken' },
      undefined,
      undefined
    );
    const brokenChild = conn.children[0]!;
    brokenChild.emit('error', new Error('ssh process failed'));
    const processFailure = await captureError(processError);
    expect(processFailure.message).toBe('ssh process failed');
    expect(conn.spawnCalls).toHaveLength(1);
  });
});
