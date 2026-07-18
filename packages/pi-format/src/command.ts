// ABOUTME: Registers the /format slash command (files + config TUI).
// ABOUTME: Formats paths on demand and edits global/project config flags via SettingsList.

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import {
  type ConfigScope,
  getConfigFilePath,
  listConfigurableSettings,
  setSettingEnabled,
} from './config.ts';
import { errorMessage } from './log.ts';
import { formatPaths, formatSummaryText } from './service.ts';
import type { FormatServiceContext } from './types.ts';

const CONFIG_SUBCOMMAND = 'config';
const CONFIG_SCOPES = ['global', 'project'] as const;
const ENABLED_VALUE = 'enabled';
const DISABLED_VALUE = 'disabled';

export function registerFormatCommand(pi: ExtensionAPI): void {
  pi.registerCommand('format', {
    description:
      'Format files, or open /format config <global|project> to toggle enabled settings.',
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      return getFormatArgumentCompletions(prefix);
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === CONFIG_SUBCOMMAND || trimmed.startsWith(`${CONFIG_SUBCOMMAND} `)) {
        const scopeArg = trimmed.slice(CONFIG_SUBCOMMAND.length).trim();
        await handleConfigCommand(scopeArg, ctx);
        return;
      }

      const { paths, formatter } = parseCommandArgs(args);

      if (paths.length === 0) {
        ctx.ui.notify(
          'Usage: /format <path...> | /format --formatter <name> <path...> | /format config <global|project>',
          'warning'
        );
        return;
      }

      await ctx.waitForIdle();

      try {
        const result = await formatPaths(paths, { mode: 'explicit', formatter }, makeCtx(pi, ctx));
        const text = formatSummaryText(result);

        if (result.failed.length > 0) {
          ctx.ui.notify(text, 'error');
          return;
        }
        if (result.formatted.length === 0 && result.skipped.length > 0) {
          ctx.ui.notify(text, 'warning');
          return;
        }
        ctx.ui.notify(text, 'info');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Formatting failed: ${message}`, 'error');
      }
    },
  });
}

export function getFormatArgumentCompletions(prefix: string): AutocompleteItem[] | null {
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

  // Only suggest the config subcommand when the user is typing a command token,
  // not when they already started a file path or --formatter flag.
  if (trimmed === '' || CONFIG_SUBCOMMAND.startsWith(trimmed)) {
    return [{ value: CONFIG_SUBCOMMAND, label: CONFIG_SUBCOMMAND }];
  }

  return null;
}

async function handleConfigCommand(scopeArg: string, ctx: ExtensionCommandContext): Promise<void> {
  if (scopeArg !== 'global' && scopeArg !== 'project') {
    ctx.ui.notify('Usage: /format config <global|project>', 'info');
    return;
  }

  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/format config requires TUI mode.', 'error');
    return;
  }

  const scope: ConfigScope = scopeArg;
  let entries;
  try {
    entries = await listConfigurableSettings(scope, ctx.cwd);
  } catch (error) {
    ctx.ui.notify(`Failed to load format ${scope} config: ${errorMessage(error)}`, 'error');
    return;
  }

  const configPath = getConfigFilePath(scope, ctx.cwd);

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      currentValue: entry.enabled ? ENABLED_VALUE : DISABLED_VALUE,
      values: [ENABLED_VALUE, DISABLED_VALUE],
    }));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        void persistSettingToggle(scope, ctx, id, newValue === ENABLED_VALUE, (ok) => {
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
            `Format ${scope} config — space toggles, esc closes (reload session to apply registration)`
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

async function persistSettingToggle(
  scope: ConfigScope,
  ctx: ExtensionCommandContext,
  id: string,
  enabled: boolean,
  onSettled: (ok: boolean) => void
): Promise<void> {
  try {
    await setSettingEnabled(scope, ctx.cwd, id, enabled);
    onSettled(true);
  } catch (error) {
    ctx.ui.notify(
      `Failed to save ${id}=${enabled} in ${scope} config: ${errorMessage(error)}`,
      'error'
    );
    onSettled(false);
  }
}

function parseCommandArgs(args: string): { paths: string[]; formatter?: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const paths: string[] = [];
  let formatter: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--formatter' || token === '-f') {
      formatter = tokens[++i];
      continue;
    }
    paths.push(token);
  }

  return { paths, formatter };
}

function makeCtx(pi: ExtensionAPI, ctx: ExtensionCommandContext): FormatServiceContext {
  return {
    cwd: ctx.cwd,
    exec: (command, args, options) => pi.exec(command, args, { cwd: ctx.cwd, ...options }),
  };
}
