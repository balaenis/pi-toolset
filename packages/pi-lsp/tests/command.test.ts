// ABOUTME: Unit tests for /lsp status detail formatting and argument completions.
// ABOUTME: Uses fake manager/server objects so no language-server process is started.

import { describe, expect, it } from 'bun:test';
import type { LSPServerInstance } from '../src/instance.ts';
import type { LSPServerManager } from '../src/manager.ts';
import { formatLspStatusDetails, getLspArgumentCompletions } from '../src/command.ts';
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
      { value: 'config', label: 'config' },
    ]);
    expect(getLspArgumentCompletions('st')).toEqual([
      { value: 'status', label: 'status' },
      { value: 'start', label: 'start' },
    ]);
    expect(getLspArgumentCompletions('c')).toEqual([{ value: 'config', label: 'config' }]);
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
});
