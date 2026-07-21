// ABOUTME: Unit tests for /lsp status detail formatting, completions, and clean.
// ABOUTME: Uses fake manager/server objects so no language-server process is started.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanDiagnostics,
  formatLspStatusDetails,
  getLspArgumentCompletions,
} from '../src/command.ts';
import { drain, hasDiagnostics, register, resetAll } from '../src/diagnostics.ts';
import type { LSPServerInstance } from '../src/instance.ts';
import type { LSPServerManager } from '../src/manager.ts';
import type { LspServerState, ScopedLspServerConfig } from '../src/types.ts';

function fakeServer(
  name: string,
  state: LspServerState,
  overrides: Partial<LSPServerInstance> = {}
): LSPServerInstance {
  const config: ScopedLspServerConfig = {
    command: `${name}-server`,
    args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript' },
    workspaceFolder: '/workspace',
    role: 'primary',
  };

  return {
    name,
    config,
    state,
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    capabilities: undefined,
    async start() {},
    async stop() {},
    async restart() {},
    isHealthy: () => state === 'running',
    async sendRequest() {
      return undefined as never;
    },
    async sendNotification() {},
    onNotification() {},
    onRequest() {},
    ...overrides,
  };
}

function fakeManager(servers: LSPServerInstance[]): LSPServerManager {
  const serverMap = new Map(servers.map((server) => [server.name, server]));

  return {
    async initialize() {},
    async shutdown() {},
    getServerForFile: () => servers[0],
    getConfiguredServersForFile: () => servers,
    getServersForFile: () => servers,
    getPrimaryServerForFile: () => servers[0],
    ensureServerStarted: async () => servers[0],
    sendRequest: async () => undefined,
    getAllServers: () => serverMap,
    getStateCounts: () => ({ running: 0, starting: 0, error: 0 }),
    onServersChanged: () => () => {},
    async openFile() {},
    async changeFile() {},
    async saveFile() {},
    async closeFile() {},
    async syncFileChange() {},
    isFileOpen: () => false,
    isFileOpenInServer: () => false,
  };
}

describe('formatLspStatusDetails', () => {
  it('reports an unavailable manager', () => {
    expect(formatLspStatusDetails(undefined)).toBe(
      ['LSP status', '', 'Manager: not initialized or initialization failed.'].join('\n')
    );
  });

  it('reports an empty configured server set', () => {
    expect(formatLspStatusDetails(fakeManager([]))).toBe(
      [
        'LSP status',
        '',
        'Manager: initialized',
        'Servers: 0',
        'States: running 0, starting 0, stopped 0, stopping 0, error 0',
        '',
        'No LSP servers are configured or autodetected for this session.',
      ].join('\n')
    );
  });

  it('includes counts and per-server details', () => {
    const started = new Date('2026-06-20T00:00:00.000Z');
    const output = formatLspStatusDetails(
      fakeManager([
        fakeServer('typescript', 'running', {
          startTime: started,
          config: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: { '.tsx': 'typescriptreact', '.ts': 'typescript' },
            workspaceFolder: '/repo',
          },
        }),
        fakeServer('python', 'error', {
          lastError: new Error('pyright failed'),
          restartCount: 2,
          config: {
            command: 'pyright-langserver',
            args: ['--stdio', '--flag with space'],
            extensionToLanguage: { '.py': 'python' },
            workspaceFolder: '/repo',
          },
        }),
      ])
    );

    expect(output).toContain('Manager: initialized');
    expect(output).toContain('Servers: 2');
    expect(output).toContain('States: running 1, starting 0, stopped 0, stopping 0, error 1');
    expect(output).toContain('- python: error');
    expect(output).toContain("command: pyright-langserver --stdio '--flag with space'");
    expect(output).toContain('  restarts: 2');
    expect(output).toContain('  last error: pyright failed');
    expect(output).toContain('- typescript: running');
    expect(output).toContain('  extensions: .ts, .tsx');
    expect(output).toContain('  started: 2026-06-20T00:00:00.000Z');
    expect(output).toContain('  role: primary');
  });

  it('shows role and conflictGroup for primary and companion servers', () => {
    const output = formatLspStatusDetails(
      fakeManager([
        fakeServer('typescript', 'running', {
          config: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript' },
            workspaceFolder: '/repo',
            role: 'primary',
            conflictGroup: 'typescript',
          },
        }),
        fakeServer('eslint', 'stopped', {
          config: {
            command: 'eslint-lsp',
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript' },
            workspaceFolder: '/repo',
            role: 'companion',
          },
        }),
        fakeServer('tailwindcss', 'running', {
          config: {
            command: 'tailwindcss-language-server',
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript' },
            workspaceFolder: '/repo',
            role: 'companion',
          },
        }),
      ])
    );

    expect(output).toContain('- typescript: running');
    expect(output).toContain('  role: primary');
    expect(output).toContain('  conflictGroup: typescript');

    expect(output).toContain('- eslint: stopped');
    expect(output).toContain('  role: companion');

    expect(output).toContain('- tailwindcss: running');
    expect(output).not.toContain('startup:');
    expect(output).not.toContain('manual active');
  });
});

describe('getLspArgumentCompletions', () => {
  it('completes top-level subcommands', () => {
    expect(getLspArgumentCompletions('')).toEqual([
      { value: 'status', label: 'status' },
      { value: 'start', label: 'start' },
      { value: 'diagnostics', label: 'diagnostics' },
      { value: 'clean', label: 'clean' },
      { value: 'config', label: 'config' },
    ]);
    expect(getLspArgumentCompletions('st')).toEqual([
      { value: 'status', label: 'status' },
      { value: 'start', label: 'start' },
    ]);
    expect(getLspArgumentCompletions('c')).toEqual([
      { value: 'clean', label: 'clean' },
      { value: 'config', label: 'config' },
    ]);
  });

  it('completes config scopes', () => {
    expect(getLspArgumentCompletions('config')).toEqual([
      { value: 'config global', label: 'config global' },
      { value: 'config project', label: 'config project' },
    ]);
    expect(getLspArgumentCompletions('config p')).toEqual([
      { value: 'config project', label: 'config project' },
    ]);
    expect(getLspArgumentCompletions('config x')).toBeNull();
  });

  it('completes clean force', () => {
    expect(getLspArgumentCompletions('clean')).toEqual([
      { value: 'clean force', label: 'clean force' },
    ]);
    expect(getLspArgumentCompletions('clean f')).toEqual([
      { value: 'clean force', label: 'clean force' },
    ]);
    expect(getLspArgumentCompletions('clean x')).toBeNull();
  });
});

const SAMPLE_DIAGNOSTIC = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: 'stale error',
  severity: 1 as const,
  source: 'ts',
};

describe('cleanDiagnostics', () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetAll();
  });

  it('reports usage for unknown clean args', async () => {
    const message = await cleanDiagnostics({
      force: false,
      cleanArg: 'now',
      cwd: '/tmp',
      manager: undefined,
    });
    expect(message).toBe('Usage: /lsp clean | /lsp clean force');
  });

  it('reports no-op when force has nothing tracked', async () => {
    const message = await cleanDiagnostics({
      force: true,
      cleanArg: 'force',
      cwd: '/tmp',
      manager: undefined,
    });
    expect(message).toBe('No pending or delivered diagnostics to clear.');
  });

  it('reports no-op when bare clean has nothing tracked', async () => {
    const message = await cleanDiagnostics({
      force: false,
      cleanArg: '',
      cwd: '/tmp',
      manager: fakeManager([fakeServer('typescript', 'running')]),
    });
    expect(message).toBe('No pending or delivered diagnostics to clean.');
  });

  it('force-clears pending diagnostics without a manager', async () => {
    register('ts', 'file:///tmp/a.ts', [SAMPLE_DIAGNOSTIC]);

    const message = await cleanDiagnostics({
      force: true,
      cleanArg: 'force',
      cwd: '/tmp',
      manager: undefined,
    });

    expect(message).toContain('cleared (force)');
    expect(message).toContain('1 pending');
    expect(hasDiagnostics()).toBe(false);
  });

  it('force-clears delivered diagnostics without a manager', async () => {
    register('ts', 'file:///tmp/a.ts', [SAMPLE_DIAGNOSTIC]);
    expect(drain('/tmp')).not.toBeNull();
    expect(hasDiagnostics()).toBe(true);

    const message = await cleanDiagnostics({
      force: true,
      cleanArg: 'force',
      cwd: '/tmp',
      manager: undefined,
    });

    expect(message).toContain('cleared (force)');
    expect(message).toContain('1 delivered');
    expect(hasDiagnostics()).toBe(false);
  });

  it('points non-force clean at force when manager is undefined', async () => {
    register('ts', 'file:///tmp/a.ts', [SAMPLE_DIAGNOSTIC]);

    const message = await cleanDiagnostics({
      force: false,
      cleanArg: '',
      cwd: '/tmp',
      manager: undefined,
    });

    expect(message).toContain('LSP manager is not initialized');
    expect(message).toContain('/lsp clean force');
    expect(hasDiagnostics()).toBe(true);
  });

  it('re-syncs tracked files and clears when the server reports clean', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-lsp-clean-'));
    const filePath = path.join(dir, 'a.ts');
    await writeFile(filePath, 'const x = 1;\n', 'utf8');
    const uri = pathToFileURL(filePath).href;

    register('typescript', uri, [SAMPLE_DIAGNOSTIC]);

    const synced: string[] = [];
    const manager = fakeManager([fakeServer('typescript', 'running')]);
    manager.syncFileChange = async (target) => {
      synced.push(target);
      // Simulate a clean pull/publish after re-sync.
      register('typescript', uri, []);
    };

    try {
      const message = await cleanDiagnostics({
        force: false,
        cleanArg: '',
        cwd: dir,
        manager,
        settleMs: 0,
      });

      expect(synced).toEqual([filePath]);
      expect(message).toContain('Re-synced 1 file(s) with language servers.');
      expect(message).toContain('All tracked diagnostics cleared after server refresh.');
      expect(hasDiagnostics()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears delivered-only residuals when re-sync publishes clean', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-lsp-clean-delivered-'));
    const filePath = path.join(dir, 'a.ts');
    await writeFile(filePath, 'const x = 1;\n', 'utf8');
    const uri = pathToFileURL(filePath).href;

    register('typescript', uri, [SAMPLE_DIAGNOSTIC]);
    expect(drain(dir)).not.toBeNull();
    // Pending is gone; only delivered tracking remains.
    expect(hasDiagnostics()).toBe(true);

    const manager = fakeManager([fakeServer('typescript', 'running')]);
    manager.syncFileChange = async () => {
      register('typescript', uri, []);
    };

    try {
      const message = await cleanDiagnostics({
        force: false,
        cleanArg: '',
        cwd: dir,
        manager,
        settleMs: 0,
      });

      expect(message).toContain('Tracked before: 0 pending, 1 delivered');
      expect(message).toContain('All tracked diagnostics cleared after server refresh.');
      expect(hasDiagnostics()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports remaining residuals when re-sync re-registers the same issue', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-lsp-clean-residual-'));
    const filePath = path.join(dir, 'a.ts');
    await writeFile(filePath, 'const x = 1;\n', 'utf8');
    const uri = pathToFileURL(filePath).href;

    register('typescript', uri, [SAMPLE_DIAGNOSTIC]);

    const manager = fakeManager([fakeServer('typescript', 'running')]);
    manager.syncFileChange = async () => {
      // Server still reports the same issue — not a clean publish.
      register('typescript', uri, [SAMPLE_DIAGNOSTIC]);
    };

    try {
      const message = await cleanDiagnostics({
        force: false,
        cleanArg: '',
        cwd: dir,
        manager,
        settleMs: 0,
      });

      expect(message).toContain('Re-synced 1 file(s)');
      expect(message).toContain('Remaining: 1 pending, 0 delivered across 1 file(s).');
      expect(message).toContain('/lsp clean force');
      expect(hasDiagnostics()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips files with no covering language server', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-lsp-clean-skip-'));
    const filePath = path.join(dir, 'a.ts');
    await writeFile(filePath, 'const x = 1;\n', 'utf8');
    const uri = pathToFileURL(filePath).href;

    register('typescript', uri, [SAMPLE_DIAGNOSTIC]);

    let synced = 0;
    const manager = fakeManager([]);
    manager.syncFileChange = async () => {
      synced++;
    };

    try {
      const message = await cleanDiagnostics({
        force: false,
        cleanArg: '',
        cwd: dir,
        manager,
        settleMs: 0,
      });

      expect(synced).toBe(0);
      expect(message).toContain('Re-synced 0 file(s)');
      expect(message).toContain(
        'Skipped 1 file(s) with no covering language server (residuals left intact).'
      );
      expect(message).toContain('Remaining: 1 pending');
      expect(hasDiagnostics()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts failed re-syncs when syncFileChange throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-lsp-clean-fail-'));
    const filePath = path.join(dir, 'a.ts');
    await writeFile(filePath, 'const x = 1;\n', 'utf8');
    const uri = pathToFileURL(filePath).href;

    register('typescript', uri, [SAMPLE_DIAGNOSTIC]);

    const manager = fakeManager([fakeServer('typescript', 'running')]);
    manager.syncFileChange = async () => {
      throw new Error('sync blew up');
    };

    try {
      const message = await cleanDiagnostics({
        force: false,
        cleanArg: '',
        cwd: dir,
        manager,
        settleMs: 0,
      });

      expect(message).toContain('Re-synced 0 file(s)');
      expect(message).toContain('Failed to re-sync 1 file(s).');
      expect(message).toContain('Remaining: 1 pending');
      expect(hasDiagnostics()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clears diagnostics for files that no longer exist', async () => {
    const missingUri = 'file:///tmp/pi-lsp-missing-clean.ts';
    register('typescript', missingUri, [SAMPLE_DIAGNOSTIC]);

    const manager = fakeManager([fakeServer('typescript', 'running')]);
    manager.syncFileChange = async () => {
      throw new Error('should not sync missing files');
    };

    const message = await cleanDiagnostics({
      force: false,
      cleanArg: '',
      cwd: '/tmp',
      manager,
      settleMs: 0,
    });

    expect(message).toContain('unreadable/missing');
    expect(hasDiagnostics()).toBe(false);
  });
});
