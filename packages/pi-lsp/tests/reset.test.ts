// ABOUTME: Tests /lsp reset against the real manager and extension lifecycle.
// ABOUTME: Verifies fresh server state, config reload, diagnostics, notifications, and status subscriptions.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as diagnostics from '../src/diagnostics.ts';
import extension from '../src/index.ts';
import { getManager, waitForInitialization } from '../src/manager.ts';
import { maybeNotifyMissingServer, resetMissingServerNotifications } from '../src/notifications.ts';

type Command = Parameters<ExtensionAPI['registerCommand']>[1];
type CommandContext = Parameters<Command['handler']>[1];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const SAMPLE_DIAGNOSTIC = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: 'tracked error',
  severity: 1 as const,
};

function makeHarness(cwd: string) {
  const handlers = new Map<string, Handler>();
  let command: Command | undefined;
  const statuses: (string | undefined)[] = [];
  const notifications: { message: string; level: string }[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand(_name: string, definition: Command) {
      command = definition;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: 'tui',
    hasUI: true,
    async waitForIdle() {},
    ui: {
      theme: { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` },
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as CommandContext;
  extension(pi);

  return {
    ctx,
    statuses,
    notifications,
    async start() {
      await handlers.get('session_start')!({}, ctx);
      await waitForInitialization();
    },
    reset: () => command!.handler('reset', ctx),
    shutdown: () => handlers.get('session_shutdown')!({}, ctx),
  };
}

describe('/lsp reset lifecycle', () => {
  let root: string;
  let configPath: string;
  let harness: ReturnType<typeof makeHarness>;
  let originalEnv: Record<string, string | undefined>;

  async function writeConfig(name = 'reset-server'): Promise<void> {
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          [name]: {
            command: path.join(root, 'missing-language-server'),
            extensionToLanguage: { '.ts': 'typescript' },
            maxRestarts: 1,
          },
        },
      })
    );
  }

  beforeEach(async () => {
    originalEnv = {
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_LSP_LOG_FILE: process.env.PI_LSP_LOG_FILE,
    };
    root = await mkdtemp(path.join(tmpdir(), 'pi-lsp-reset-'));
    process.env.PATH = '';
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
    process.env.PI_LSP_LOG_FILE = path.join(root, 'lsp.log');
    configPath = path.join(root, '.pi', '@balaenis', 'pi-lsp', 'config.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeConfig();
    diagnostics.resetAll();
    resetMissingServerNotifications();
    harness = makeHarness(root);
  });

  afterEach(async () => {
    await harness.shutdown();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('replaces failed instances and clears every tracked runtime state', async () => {
    await harness.start();
    const previous = getManager()!;
    const server = previous.getAllServers().get('reset-server')!;
    await expect(server.restart()).rejects.toThrow();
    expect(server.lastError).toBeDefined();
    expect(server.restartCount).toBe(1);

    const deliveredUri = pathToFileURL(path.join(root, 'delivered.ts')).href;
    const pendingUri = pathToFileURL(path.join(root, 'pending.ts')).href;
    diagnostics.register(server.name, deliveredUri, [SAMPLE_DIAGNOSTIC]);
    expect(diagnostics.drain(root)).not.toBeNull();
    diagnostics.register(server.name, pendingUri, [SAMPLE_DIAGNOSTIC]);
    maybeNotifyMissingServer('a.py', harness.ctx, 'tool');
    maybeNotifyMissingServer('a.py', harness.ctx, 'tool');
    expect(harness.notifications.filter((notice) => notice.level === 'warning')).toHaveLength(1);

    await harness.reset();

    const current = getManager()!;
    const fresh = current.getAllServers().get(server.name)!;
    expect(current).not.toBe(previous);
    expect(previous.getAllServers().size).toBe(0);
    expect(previous.getServersForFile('a.ts')).toEqual([]);
    expect(server.state).toBe('stopped');
    expect(fresh).not.toBe(server);
    expect(fresh.state).toBe('stopped');
    expect(fresh.lastError).toBeUndefined();
    expect(fresh.startTime).toBeUndefined();
    expect(fresh.capabilities).toBeUndefined();
    expect(fresh.restartCount).toBe(0);
    expect(current.getStateCounts()).toEqual({ running: 0, starting: 0, error: 0 });
    expect(diagnostics.countTrackedDiagnostics()).toEqual({
      pendingIssues: 0,
      deliveredIssues: 0,
      files: 0,
    });
    expect(harness.statuses.at(-1)).toBeUndefined();
    maybeNotifyMissingServer('a.py', harness.ctx, 'tool');
    expect(harness.notifications.filter((notice) => notice.level === 'warning')).toHaveLength(2);

    // The old restart limit and permanent failure do not block a fresh attempt.
    await expect(fresh.restart()).rejects.toThrow();
    expect(fresh.restartCount).toBe(1);
    expect(fresh.lastError).toBeDefined();
    expect(harness.statuses.at(-1)).toContain('[error]✕1[/error]');
    diagnostics.register(fresh.name, pendingUri, [SAMPLE_DIAGNOSTIC]);
    expect(harness.statuses.at(-1)).toContain('[error]⚡[/error]');
    diagnostics.resetAll();
    expect(harness.statuses.at(-1)).not.toContain('[error]⚡[/error]');

    diagnostics.register(fresh.name, deliveredUri, [SAMPLE_DIAGNOSTIC]);
    expect(diagnostics.drain(root)).toContain('tracked error');
  });

  it('reloads config without changing its contents or starting servers', async () => {
    await harness.start();
    await writeConfig('replacement-server');
    const configBefore = await readFile(configPath, 'utf8');

    await harness.reset();

    expect(Array.from(getManager()!.getAllServers().keys())).toEqual(['replacement-server']);
    expect(getManager()!.getAllServers().get('replacement-server')!.state).toBe('stopped');
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
  });

  it('can reset an uninitialized runtime and repeat with no diagnostics', async () => {
    await harness.reset();
    const first = getManager()!;
    expect(first).toBeDefined();

    await harness.reset();

    expect(getManager()).toBeDefined();
    expect(getManager()).not.toBe(first);
    expect(harness.notifications.filter((notice) => notice.level === 'error')).toEqual([]);
    expect(diagnostics.hasDiagnostics()).toBe(false);
  });

  it('waits for pending configuration loading before discarding the old manager', async () => {
    const starting = harness.start();
    const previous = getManager()!;

    await harness.reset();
    await starting;

    expect(previous.getAllServers().size).toBe(0);
    expect(getManager()).not.toBe(previous);
    expect(getManager()!.getAllServers().size).toBe(1);
  });
});
