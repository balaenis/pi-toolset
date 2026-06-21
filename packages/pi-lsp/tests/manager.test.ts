// ABOUTME: Tests for multi-server file routing, lifecycle fan-out, and manual server enablement.
// ABOUTME: Uses fake LSPServerInstance objects and a temp config dir so no real LSP process is spawned.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLSPServerManager, type LSPServerInstanceFactory } from '../src/manager.ts';
import type { LSPServerInstance } from '../src/instance.ts';
import type { LspServerState, ScopedLspServerConfig } from '../src/types.ts';

interface FakeInstance extends LSPServerInstance {
  notifications: { method: string; params: unknown }[];
  requests: { method: string; params: unknown }[];
}

function fakeInstance(
  name: string,
  config: ScopedLspServerConfig,
  onStateChange?: () => void
): FakeInstance {
  const notifications: { method: string; params: unknown }[] = [];
  const requests: { method: string; params: unknown }[] = [];
  let state: LspServerState = 'stopped';
  const setState = (next: LspServerState): void => {
    if (state === next) return;
    state = next;
    onStateChange?.();
  };

  return {
    name,
    config,
    notifications,
    requests,
    get state() {
      return state;
    },
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    async start() {
      setState('running');
    },
    async stop() {
      setState('stopped');
    },
    async restart() {
      setState('running');
    },
    isHealthy: () => state === 'running',
    async sendRequest(method, params) {
      requests.push({ method, params });
      return undefined as never;
    },
    async sendNotification(method, params) {
      notifications.push({ method, params });
    },
    onNotification() {},
    onRequest() {},
  };
}

let tmpRoot: string;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-lsp-mgr-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

async function buildManager(configs: Record<string, ScopedLspServerConfig>): Promise<{
  manager: ReturnType<typeof createLSPServerManager>;
  instances: Map<string, FakeInstance>;
  cwdDir: string;
}> {
  const caseDir = mkdtempSync(path.join(tmpRoot, 'case-'));
  const cwdDir = path.join(caseDir, 'cwd');
  const agentDir = path.join(caseDir, 'agent');
  mkdirSync(cwdDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const projectConfigDir = path.join(cwdDir, '.pi', '@balaenis', 'pi-lsp');
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(path.join(projectConfigDir, 'config.json'), JSON.stringify({ servers: configs }));

  const instances = new Map<string, FakeInstance>();
  const factory: LSPServerInstanceFactory = (name, config, onStateChange) => {
    const inst = fakeInstance(name, config, onStateChange);
    instances.set(name, inst);
    return inst;
  };

  process.env.PATH = '';
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const manager = createLSPServerManager({ instanceFactory: factory });
  await manager.initialize(cwdDir);
  return { manager, instances, cwdDir };
}

function tsPrimary(): ScopedLspServerConfig {
  return {
    command: '/abs/path/typescript-language-server',
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
    role: 'primary',
    startupMode: 'auto',
  };
}

function eslintCompanion(): ScopedLspServerConfig {
  return {
    command: '/abs/path/eslint-lsp',
    extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript' },
    role: 'companion',
    startupMode: 'auto',
  };
}

function tailwindManual(): ScopedLspServerConfig {
  return {
    command: '/abs/path/tailwindcss-language-server',
    extensionToLanguage: { '.ts': 'typescript' },
    role: 'companion',
    startupMode: 'manual',
  };
}

describe('manager: configured vs active routing', () => {
  it('keeps inactive manual servers configured but excludes them from active routing', async () => {
    const { manager } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
      tailwindcss: tailwindManual(),
    });

    const configured = manager
      .getConfiguredServersForFile('/tmp/foo.ts')
      .map((s) => s.name)
      .sort();
    const active = manager
      .getServersForFile('/tmp/foo.ts')
      .map((s) => s.name)
      .sort();

    expect(configured).toEqual(['eslint', 'tailwindcss', 'typescript']);
    expect(active).toEqual(['eslint', 'typescript']);
  });

  it('returns the primary server even when a companion is listed first', async () => {
    const { manager } = await buildManager({
      eslint: eslintCompanion(),
      typescript: tsPrimary(),
    });
    expect(manager.getPrimaryServerForFile('/tmp/foo.ts')?.name).toBe('typescript');
    expect(manager.getServerForFile('/tmp/foo.ts')?.name).toBe('typescript');
  });

  it('returns undefined for primary when only companion servers cover the file', async () => {
    const { manager } = await buildManager({
      eslint: eslintCompanion(),
    });
    expect(manager.getServersForFile('/tmp/foo.ts').map((s) => s.name)).toEqual(['eslint']);
    expect(manager.getPrimaryServerForFile('/tmp/foo.ts')).toBeUndefined();
    expect(manager.getServerForFile('/tmp/foo.ts')).toBeUndefined();
  });

  it('admits a manual server into routing only after markManualServerActive', async () => {
    const { manager } = await buildManager({
      typescript: tsPrimary(),
      tailwindcss: tailwindManual(),
    });
    expect(manager.getServersForFile('/tmp/foo.ts').map((s) => s.name)).toEqual(['typescript']);

    manager.markManualServerActive('tailwindcss');
    expect(
      manager
        .getServersForFile('/tmp/foo.ts')
        .map((s) => s.name)
        .sort()
    ).toEqual(['tailwindcss', 'typescript']);

    manager.markManualServerInactive('tailwindcss');
    expect(manager.getServersForFile('/tmp/foo.ts').map((s) => s.name)).toEqual(['typescript']);
  });
});

describe('manager: lifecycle fan-out', () => {
  it('opens a .ts file on both the primary and the active companion', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'export const x = 1;');

    await manager.openFile(filePath, 'export const x = 1;');

    expect(instances.get('typescript')!.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
    ]);
    expect(instances.get('eslint')!.notifications.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
    ]);
  });

  it('inactive manual servers receive no lifecycle notifications', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      tailwindcss: tailwindManual(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.changeFile(filePath, 'v2');
    await manager.saveFile(filePath);

    expect(instances.get('tailwindcss')!.notifications).toEqual([]);
    expect(instances.get('typescript')!.notifications.length).toBeGreaterThan(0);
  });

  it('fans didChange and didSave to every active server after open', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.changeFile(filePath, 'v2');
    await manager.saveFile(filePath);

    for (const name of ['typescript', 'eslint']) {
      const methods = instances.get(name)!.notifications.map((n) => n.method);
      expect(methods).toContain('textDocument/didOpen');
      expect(methods).toContain('textDocument/didChange');
      expect(methods).toContain('textDocument/didSave');
    }
  });

  it('closeFile sends didClose to every server that has the file open', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.closeFile(filePath);

    for (const name of ['typescript', 'eslint']) {
      const methods = instances.get(name)!.notifications.map((n) => n.method);
      expect(methods).toContain('textDocument/didClose');
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    expect(manager.isFileOpenInServer(fileUri, 'typescript')).toBe(false);
    expect(manager.isFileOpenInServer(fileUri, 'eslint')).toBe(false);
  });

  it('does not duplicate didOpen across repeated openFile calls', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.openFile(filePath, 'v1');

    for (const name of ['typescript', 'eslint']) {
      const opens = instances
        .get(name)!
        .notifications.filter((n) => n.method === 'textDocument/didOpen');
      expect(opens.length).toBe(1);
    }
  });

  it('clears open-file tracking when a server stops, so the next start re-sends didOpen', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    const fileUri = pathToFileURL(path.resolve(filePath)).href;
    expect(manager.isFileOpenInServer(fileUri, 'typescript')).toBe(true);

    // Stop the server (e.g. via /lsp start picker). The state-change listener
    // should clear the stale tracking entry.
    const ts = instances.get('typescript')!;
    await ts.stop();
    expect(manager.isFileOpenInServer(fileUri, 'typescript')).toBe(false);

    // Re-opening should produce a fresh didOpen rather than being skipped.
    await manager.openFile(filePath, 'v1');
    const opens = ts.notifications.filter((n) => n.method === 'textDocument/didOpen');
    expect(opens.length).toBe(2);
  });
});

describe('manager: primary-only request routing', () => {
  it('sendRequest targets the active primary server only', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
      tailwindcss: tailwindManual(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    await manager.openFile(filePath, 'v1');
    await manager.sendRequest(filePath, 'textDocument/definition', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: 0, character: 0 },
    });

    expect(instances.get('typescript')!.requests.map((r) => r.method)).toEqual([
      'textDocument/definition',
    ]);
    expect(instances.get('eslint')!.requests).toEqual([]);
    expect(instances.get('tailwindcss')!.requests).toEqual([]);
  });

  it('still opens active companions before primary-only requests', async () => {
    const { manager, instances, cwdDir } = await buildManager({
      typescript: tsPrimary(),
      eslint: eslintCompanion(),
    });
    const filePath = path.join(cwdDir, 'foo.ts');
    writeFileSync(filePath, 'v1');

    // The tool flow calls openFile() before sendRequest(); replicate that here.
    await manager.openFile(filePath, 'v1');
    await manager.sendRequest(filePath, 'textDocument/hover', {
      textDocument: { uri: pathToFileURL(filePath).href },
      position: { line: 0, character: 0 },
    });

    expect(instances.get('eslint')!.notifications.map((n) => n.method)).toContain(
      'textDocument/didOpen'
    );
    expect(instances.get('eslint')!.requests).toEqual([]);
  });
});
