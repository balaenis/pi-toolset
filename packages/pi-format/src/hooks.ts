// ABOUTME: Automatic post-write/edit formatting hook.
// ABOUTME: Listens for successful write/edit tool results and formats the target file.

import * as path from 'node:path';
import {
  isEditToolResult,
  isWriteToolResult,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getFormatConfig } from './config.ts';
import { formatPaths } from './service.ts';
import { logDebug, logError } from './log.ts';
import type { FormatServiceContext } from './types.ts';

/**
 * Register the auto-format hook when config allows it.
 * Skips registration when `enabled` or `formatOnWrite` is false so the
 * extension does not listen for tool results at all. Config is read from
 * `cwd` (defaults to `process.cwd()`); reload the extension after changing it.
 */
export async function registerFormatHooks(
  pi: ExtensionAPI,
  cwd: string = process.cwd()
): Promise<boolean> {
  const config = await getFormatConfig(cwd);
  if (!config.enabled || !config.formatOnWrite) {
    logDebug(
      `hook: not registered (enabled=${config.enabled} formatOnWrite=${config.formatOnWrite})`
    );
    return false;
  }

  pi.on('tool_result', async (event, ctx) => {
    if (!isWriteToolResult(event) && !isEditToolResult(event)) return;
    if (event.isError) return;

    const input = event.input as { path?: unknown };
    if (!input.path || typeof input.path !== 'string') return;

    const absolutePath = path.resolve(ctx.cwd, input.path);
    logDebug(`hook: auto-formatting ${absolutePath}`);

    try {
      await withFileMutationQueue(absolutePath, async () => {
        const result = await formatPaths([absolutePath], { mode: 'automatic' }, makeCtx(pi, ctx));

        if (result.disabled) {
          logDebug('hook: formatting disabled');
          return;
        }

        if (result.failed.length > 0) {
          const failure = result.failed[0]!;
          logError(new Error(`hook: auto-format failed for ${failure.filePath}: ${failure.error}`));
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Auto-format failed for ${failure.filePath}: ${failure.error}`,
              'warning'
            );
          }
        } else if (result.formatted.length > 0) {
          logDebug(`hook: formatted ${absolutePath}`);
        }
      });
    } catch (error) {
      logError(error);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto-format error: ${error instanceof Error ? error.message : String(error)}`,
          'warning'
        );
      }
    }
  });

  logDebug('hook: registered tool_result auto-format handler');
  return true;
}

function makeCtx(pi: ExtensionAPI, ctx: { cwd: string }): FormatServiceContext {
  return {
    cwd: ctx.cwd,
    exec: (command, args, options) => pi.exec(command, args, { cwd: ctx.cwd, ...options }),
  };
}
