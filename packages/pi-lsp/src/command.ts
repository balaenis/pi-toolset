// ABOUTME: Registers the /lsp slash command (status, start/stop, diagnostics, clean, config) and its handlers.
// ABOUTME: /lsp status formats live state; /lsp start toggles processes; /lsp clean refreshes or force-clears diagnostics.

import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import {
  type ConfigScope,
  getConfigFilePath,
  listConfigurableServers,
  setServerEnabled,
} from './config.ts';
import * as diagnostics from './diagnostics.ts';
import type { LSPServerInstance } from './instance.ts';
import { errorMessage, logForDebugging } from './log.ts';
import {
  getManager,
  initializeManager,
  type LSPServerManager,
  waitForInitialization,
} from './manager.ts';
import type { LspServerState } from './types.ts';

const STATUS_SUBCOMMAND = 'status';
const START_SUBCOMMAND = 'start';
const DIAGNOSTICS_SUBCOMMAND = 'diagnostics';
const CLEAN_SUBCOMMAND = 'clean';
const CLEAN_FORCE_ARG = 'force';
const CONFIG_SUBCOMMAND = 'config';
const CONFIG_SCOPES = ['global', 'project'] as const;
const SUBCOMMANDS = [
  STATUS_SUBCOMMAND,
  START_SUBCOMMAND,
  DIAGNOSTICS_SUBCOMMAND,
  CLEAN_SUBCOMMAND,
  CONFIG_SUBCOMMAND,
];

/**
 * How long `/lsp clean` waits after re-syncing so push-based servers can
 * re-publish diagnostics before we report the remaining state.
 */
const PUSH_DIAGNOSTICS_SETTLE_MS = 500;

const ENABLED_VALUE = 'enabled';
const DISABLED_VALUE = 'disabled';

export function registerLspCommand(pi: ExtensionAPI): void {
  pi.registerCommand('lsp', {
    description:
      'Inspect LSP status, start/stop servers, toggle config enabled flags, list or clean diagnostics',
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      return getLspArgumentCompletions(prefix);
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();

      if (subcommand === CONFIG_SUBCOMMAND || subcommand.startsWith(`${CONFIG_SUBCOMMAND} `)) {
        const scopeArg = subcommand.slice(CONFIG_SUBCOMMAND.length).trim();
        await handleConfigCommand(scopeArg, ctx);
        return;
      }

      // Force clean is local-only — skip manager init entirely.
      if (subcommand === CLEAN_SUBCOMMAND || subcommand.startsWith(`${CLEAN_SUBCOMMAND} `)) {
        const cleanArg = subcommand.slice(CLEAN_SUBCOMMAND.length).trim();
        if (cleanArg === CLEAN_FORCE_ARG) {
          const message = await cleanDiagnostics({
            force: true,
            cleanArg,
            cwd: ctx.cwd,
            manager: undefined,
          });
          ctx.ui.notify(message, 'info');
          return;
        }
      }

      initializeManager(ctx.cwd);
      await waitForInitialization();
      const manager = getManager();

      if (subcommand === START_SUBCOMMAND) {
        await handleStartCommand(manager, ctx);
        return;
      }

      if (subcommand === DIAGNOSTICS_SUBCOMMAND) {
        ctx.ui.notify(diagnostics.formatDiagnosticsState(ctx.cwd), 'info');
        return;
      }

      if (subcommand === CLEAN_SUBCOMMAND || subcommand.startsWith(`${CLEAN_SUBCOMMAND} `)) {
        const cleanArg = subcommand.slice(CLEAN_SUBCOMMAND.length).trim();
        const message = await cleanDiagnostics({
          force: false,
          cleanArg,
          cwd: ctx.cwd,
          manager,
        });
        ctx.ui.notify(message, 'info');
        return;
      }

      // Empty input defaults to status.
      if (subcommand !== '' && subcommand !== STATUS_SUBCOMMAND) {
        ctx.ui.notify(
          'Usage: /lsp status | /lsp start | /lsp diagnostics | /lsp clean [force] | /lsp config <global|project>',
          'info'
        );
        return;
      }

      ctx.ui.notify(formatLspStatusDetails(manager), manager ? 'info' : 'warning');
    },
  });
}

type CommandContext = Parameters<Parameters<ExtensionAPI['registerCommand']>[1]['handler']>[1];

export function getLspArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();

  if (trimmed === CONFIG_SUBCOMMAND || trimmed.startsWith(`${CONFIG_SUBCOMMAND} `)) {
    const rest = trimmed.slice(CONFIG_SUBCOMMAND.length).trimStart();
    const matches = CONFIG_SCOPES.filter((scope) => scope.startsWith(rest));
    if (matches.length === 0) return null;
    return matches.map((scope) => ({
      value: `${CONFIG_SUBCOMMAND} ${scope}`,
      label: `${CONFIG_SUBCOMMAND} ${scope}`,
    }));
  }

  if (trimmed === CLEAN_SUBCOMMAND || trimmed.startsWith(`${CLEAN_SUBCOMMAND} `)) {
    const rest = trimmed.slice(CLEAN_SUBCOMMAND.length).trimStart();
    if (!CLEAN_FORCE_ARG.startsWith(rest)) return null;
    return [
      {
        value: `${CLEAN_SUBCOMMAND} ${CLEAN_FORCE_ARG}`,
        label: `${CLEAN_SUBCOMMAND} ${CLEAN_FORCE_ARG}`,
      },
    ];
  }

  const matches = SUBCOMMANDS.filter((name) => name.startsWith(trimmed));
  if (matches.length === 0) return null;
  return matches.map((name) => ({ value: name, label: name }));
}

/**
 * Refresh or discard tracked diagnostics.
 *
 * - Default: re-sync every tracked file with its language servers (pull + push
 *   settle), so clean server reports can clear pending/delivered state.
 * - `force`: drop all pending and delivered diagnostics without querying servers.
 */
export async function cleanDiagnostics(options: {
  force: boolean;
  cleanArg: string;
  cwd: string;
  manager: LSPServerManager | undefined;
  /** Injectable settle delay for tests. Defaults to PUSH_DIAGNOSTICS_SETTLE_MS. */
  settleMs?: number;
}): Promise<string> {
  const { force, cleanArg, cwd, manager } = options;

  if (cleanArg !== '' && cleanArg !== CLEAN_FORCE_ARG) {
    return 'Usage: /lsp clean | /lsp clean force';
  }

  if (force) {
    const before = diagnostics.countTrackedDiagnostics();
    if (before.files === 0) {
      return 'No pending or delivered diagnostics to clear.';
    }
    diagnostics.resetAll();
    return [
      'LSP diagnostics cleared (force).',
      `Discarded ${before.pendingIssues} pending and ${before.deliveredIssues} delivered issue(s) across ${before.files} file(s).`,
      'Servers were not re-queried.',
    ].join('\n');
  }

  const uris = diagnostics.listTrackedUris();
  if (uris.length === 0) {
    return 'No pending or delivered diagnostics to clean.';
  }

  if (!manager) {
    return 'LSP manager is not initialized; cannot re-query servers. Use /lsp clean force to discard local state.';
  }

  const before = diagnostics.countTrackedDiagnostics();
  let refreshed = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;

  await Promise.all(
    uris.map(async (uri) => {
      let filePath: string;
      try {
        filePath = fileURLToPath(uri);
      } catch {
        diagnostics.clearForUri(uri);
        missing++;
        return;
      }

      try {
        await access(filePath);
      } catch {
        diagnostics.clearForUri(uri);
        missing++;
        return;
      }

      // syncFileChange is a no-op when no server covers the file and almost never
      // throws (it swallows read/per-server failures). Treat no-cover as skipped
      // so we do not claim a re-sync that could not clear residuals.
      if (manager.getServersForFile(filePath).length === 0) {
        skipped++;
        return;
      }

      try {
        await manager.syncFileChange(filePath);
        refreshed++;
      } catch (error) {
        failed++;
        logForDebugging(`LSP: clean re-sync failed for ${filePath}: ${errorMessage(error)}`);
      }
    })
  );

  const settleMs = options.settleMs ?? PUSH_DIAGNOSTICS_SETTLE_MS;
  if (refreshed > 0 && settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  const after = diagnostics.countTrackedDiagnostics();
  const lines = [
    'LSP diagnostics clean',
    '',
    `Tracked before: ${before.pendingIssues} pending, ${before.deliveredIssues} delivered across ${before.files} file(s).`,
    `Re-synced ${refreshed} file(s) with language servers.`,
  ];

  if (skipped > 0) {
    lines.push(
      `Skipped ${skipped} file(s) with no covering language server (residuals left intact).`
    );
  }
  if (missing > 0) {
    lines.push(`Cleared ${missing} unreadable/missing file(s).`);
  }
  if (failed > 0) {
    lines.push(`Failed to re-sync ${failed} file(s).`);
  }

  if (after.files === 0) {
    lines.push('All tracked diagnostics cleared after server refresh.');
  } else {
    lines.push(
      `Remaining: ${after.pendingIssues} pending, ${after.deliveredIssues} delivered across ${after.files} file(s).`
    );
    lines.push(
      'If residuals look stale, re-check with /lsp diagnostics or discard them with /lsp clean force.'
    );
    lines.push('');
    lines.push(diagnostics.formatDiagnosticsState(cwd));
  }

  return lines.join('\n');
}

async function handleConfigCommand(scopeArg: string, ctx: CommandContext): Promise<void> {
  if (scopeArg !== 'global' && scopeArg !== 'project') {
    ctx.ui.notify('Usage: /lsp config <global|project>', 'info');
    return;
  }

  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/lsp config requires TUI mode.', 'error');
    return;
  }

  const scope: ConfigScope = scopeArg;
  let entries;
  try {
    entries = await listConfigurableServers(scope, ctx.cwd);
  } catch (error) {
    ctx.ui.notify(`Failed to load LSP ${scope} config: ${errorMessage(error)}`, 'error');
    return;
  }

  if (entries.length === 0) {
    ctx.ui.notify('No built-in or configured LSP servers are available.', 'warning');
    return;
  }

  const configPath = getConfigFilePath(scope, ctx.cwd);

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = entries.map((entry) => ({
      id: entry.name,
      label: formatConfigEntryLabel(entry.name, entry.role, entry.source),
      description: entry.command || undefined,
      currentValue: entry.enabled ? ENABLED_VALUE : DISABLED_VALUE,
      values: [ENABLED_VALUE, DISABLED_VALUE],
    }));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        void persistEnabledToggle(scope, ctx, id, newValue === ENABLED_VALUE, (ok) => {
          if (!ok) {
            const item = items.find((candidate) => candidate.id === id);
            if (item) {
              item.currentValue = newValue === ENABLED_VALUE ? DISABLED_VALUE : ENABLED_VALUE;
            }
          }
          tui.requestRender();
        });
      },
      () => done(undefined)
    );

    const container = new Container();
    container.addChild(
      new Text(
        theme.fg(
          'accent',
          theme.bold(
            `LSP ${scope} config — space toggles enabled, esc closes (reload session to apply)`
          )
        ),
        0,
        0
      )
    );
    container.addChild(new Text(theme.fg('dim', configPath), 0, 0));
    container.addChild(settingsList);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

function formatConfigEntryLabel(
  name: string,
  role: string,
  source: 'builtin' | 'user' | 'override'
): string {
  const sourceLabel =
    source === 'builtin' ? 'builtin' : source === 'override' ? 'override' : 'user';
  return `${name} (${role}, ${sourceLabel})`;
}

async function persistEnabledToggle(
  scope: ConfigScope,
  ctx: CommandContext,
  name: string,
  enabled: boolean,
  onSettled: (ok: boolean) => void
): Promise<void> {
  try {
    await setServerEnabled(scope, ctx.cwd, name, enabled);
    onSettled(true);
  } catch (error) {
    ctx.ui.notify(
      `Failed to save enabled=${enabled} for '${name}' in ${scope} config: ${errorMessage(error)}`,
      'error'
    );
    onSettled(false);
  }
}

async function handleStartCommand(
  manager: LSPServerManager | undefined,
  ctx: CommandContext
): Promise<void> {
  if (!manager) {
    ctx.ui.notify('LSP manager is not initialized.', 'warning');
    return;
  }

  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/lsp start requires TUI mode.', 'error');
    return;
  }

  const servers = Array.from(manager.getAllServers().values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if (servers.length === 0) {
    ctx.ui.notify('No LSP servers are configured or autodetected for this session.', 'warning');
    return;
  }

  const byName = new Map(servers.map((s) => [s.name, s]));

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = servers.map((server) => ({
      id: server.name,
      label: server.name,
      currentValue: server.state,
      values: ['running', 'stopped'],
    }));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id) => {
        const server = byName.get(id);
        // Ignore toggles while a server is mid-transition; refresh resets the
        // row's displayed value back to the real state.
        if (!server || server.state === 'starting' || server.state === 'stopping') {
          refresh();
          return;
        }
        void toggleServer(server, ctx, () => refresh());
      },
      () => done(undefined)
    );

    function refresh(): void {
      for (const item of items) {
        item.currentValue = byName.get(item.id)?.state ?? item.currentValue;
      }
      tui.requestRender();
    }

    const unsubscribe = manager.onServersChanged(refresh);

    const container = new Container();
    container.addChild(
      new Text(
        theme.fg('accent', theme.bold('LSP servers — space to start/stop, esc to close')),
        0,
        0
      )
    );
    container.addChild(settingsList);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
      dispose: () => unsubscribe(),
    };
  });
}

async function toggleServer(
  server: LSPServerInstance,
  ctx: CommandContext,
  onSettled: () => void
): Promise<void> {
  const stopping = server.state === 'running' || server.state === 'stopping';
  try {
    if (stopping) {
      await server.stop();
    } else {
      await server.start();
    }
  } catch (error) {
    ctx.ui.notify(
      `Failed to ${stopping ? 'stop' : 'start'} LSP server '${server.name}': ${errorMessage(error)}`,
      'error'
    );
  } finally {
    onSettled();
  }
}

export function formatLspStatusDetails(manager: LSPServerManager | undefined): string {
  if (!manager) {
    return ['LSP status', '', 'Manager: not initialized or initialization failed.'].join('\n');
  }

  const servers = Array.from(manager.getAllServers().values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const counts = countServerStates(servers);

  const lines = [
    'LSP status',
    '',
    'Manager: initialized',
    `Servers: ${servers.length}`,
    `States: running ${counts.running}, starting ${counts.starting}, stopped ${counts.stopped}, stopping ${counts.stopping}, error ${counts.error}`,
  ];

  if (servers.length === 0) {
    lines.push('', 'No LSP servers are configured or autodetected for this session.');
    return lines.join('\n');
  }

  lines.push('', 'Server details:');
  for (const server of servers) {
    lines.push(...formatServerDetails(server));
  }

  return lines.join('\n');
}

function countServerStates(servers: LSPServerInstance[]): Record<LspServerState, number> {
  const counts: Record<LspServerState, number> = {
    stopped: 0,
    starting: 0,
    running: 0,
    stopping: 0,
    error: 0,
  };

  for (const server of servers) {
    counts[server.state]++;
  }

  return counts;
}

function formatServerDetails(server: LSPServerInstance): string[] {
  const extensions = Object.keys(server.config.extensionToLanguage).sort();
  const role = server.config.role ?? 'primary';
  const lines = [`- ${server.name}: ${server.state}`, `  role: ${role}`];
  if (server.config.conflictGroup) {
    lines.push(`  conflictGroup: ${server.config.conflictGroup}`);
  }
  lines.push(
    `  command: ${formatCommand(server.config.command, server.config.args ?? [])}`,
    `  workspace: ${server.config.workspaceFolder ?? '(session cwd)'}`,
    `  extensions: ${extensions.length > 0 ? extensions.join(', ') : '(none)'}`
  );

  if (server.startTime) {
    lines.push(`  started: ${server.startTime.toISOString()}`);
  }
  if (server.restartCount > 0) {
    lines.push(`  restarts: ${server.restartCount}`);
  }
  if (server.lastError) {
    lines.push(`  last error: ${server.lastError.message}`);
  }

  return lines;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArg).join(' ');
}

function quoteShellArg(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
