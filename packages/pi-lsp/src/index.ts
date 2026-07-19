// ABOUTME: Pi LSP extension entry point and session lifecycle wiring.
// ABOUTME: Lazily starts the manager, registers tools/commands, and injects diagnostics.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { isEditToolResult, isWriteToolResult } from '@earendil-works/pi-coding-agent';
import { drainDiagnosticMessage } from './diagnostic-delivery.ts';
import * as diagnostics from './diagnostics.ts';
import {
  initializeManager,
  getManager,
  shutdownManager,
  waitForInitialization,
} from './manager.ts';
import { maybeNotifyMissingServer } from './notifications.ts';
import { registerLspCommand } from './command.ts';
import { formatLspStatus } from './statusline.ts';
import { registerLspTool } from './tools.ts';
import { logForDebugging } from './log.ts';

/** Status segment key used to identify the LSP indicator in setStatus. */
const LSP_STATUS_KEY = 'lsp';

export default function (pi: ExtensionAPI): void {
  // No process/timer/watcher work in the factory body — registering the tool is
  // pure metadata. All process spawning is deferred to first tool use.
  registerLspTool(pi);
  registerLspCommand(pi);

  let unsubscribeLspStatus: (() => void) | undefined;
  let unsubscribeDiagnostics: (() => void) | undefined;

  pi.on('session_start', (_event, ctx) => {
    // Synchronous, non-blocking, idempotent. Servers are lazily started on the
    // first tool call (or the first edit, via syncFileChange), not here.
    initializeManager(ctx.cwd);

    const manager = getManager();
    if (!manager) return;

    const render = (): void => {
      const text = formatLspStatus(
        manager.getStateCounts(),
        (color, str) => ctx.ui.theme.fg(color, str),
        diagnostics.hasDiagnostics()
      );
      ctx.ui.setStatus(LSP_STATUS_KEY, text);
    };

    unsubscribeLspStatus?.();
    unsubscribeLspStatus = manager.onServersChanged(render);
    unsubscribeDiagnostics?.();
    unsubscribeDiagnostics = diagnostics.onChanged(render);
    render();
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    // Idempotent: fires on quit/reload/new/resume/fork. Tears down all servers
    // and clears diagnostic state so the next session starts clean.
    unsubscribeLspStatus?.();
    unsubscribeLspStatus = undefined;
    unsubscribeDiagnostics?.();
    unsubscribeDiagnostics = undefined;

    ctx.ui.setStatus(LSP_STATUS_KEY, undefined);

    await shutdownManager();
    diagnostics.resetAll();
  });

  // Passive diagnostics are next-run context: drain once at the start of a
  // user-initiated agent run into one durable hidden custom message.
  pi.on('before_agent_start', (_event, ctx) => {
    const message = drainDiagnosticMessage(ctx.cwd);
    if (!message) return;
    logForDebugging(`diagnostics: injecting durable block for ${ctx.cwd}`);
    return { message };
  });

  // After the agent edits or writes a file, drop stale pre-edit pending
  // snapshots and re-sync disk content so the server can publish a fresh set.
  // Delivered dedup keys are left intact until a clean server publish.
  pi.on('tool_result', async (event, ctx) => {
    if (!isEditToolResult(event) && !isWriteToolResult(event)) return;
    if (event.isError) return;

    const input = event.input as { path?: string };
    if (!input.path) return;

    const absolutePath = path.resolve(ctx.cwd, input.path);
    const uri = pathToFileURL(absolutePath).href;

    diagnostics.invalidatePendingForFile(uri);

    // Make sure the manager is ready, then push the disk content to the server.
    // Best-effort: never let a sync failure disrupt the agent.
    try {
      await waitForInitialization();
      const manager = getManager();
      if (manager) {
        const candidates = manager.getServersForFile(absolutePath);
        const primaryBefore = manager.getPrimaryServerForFile(absolutePath);
        // Snapshot the state *value*, not the live instance: `instance.state`
        // is a getter over mutable closure state, so re-reading after the
        // `await syncFileChange` would mirror the latest state and break the
        // "just transitioned to error" comparison below.
        const primaryStateBefore = primaryBefore?.state;

        // Surface a notification when:
        // - no configured server covers the file (recipe-hint case)
        // - the primary failed to start (lastError available)
        if (candidates.length === 0) {
          maybeNotifyMissingServer(absolutePath, ctx, 'edit');
        } else if (primaryBefore && primaryStateBefore === 'error') {
          maybeNotifyMissingServer(
            absolutePath,
            ctx,
            'edit',
            primaryBefore.name,
            primaryBefore.lastError?.message
          );
        }

        await manager.syncFileChange(absolutePath);

        // syncFileChange swallows per-server start failures so one bad server
        // can't block edit sync; re-check the primary state after sync
        // and surface a failed-start notice if it just transitioned to 'error'.
        const primaryAfter = manager.getPrimaryServerForFile(absolutePath);
        if (primaryAfter && primaryAfter.state === 'error' && primaryStateBefore !== 'error') {
          maybeNotifyMissingServer(
            absolutePath,
            ctx,
            'edit',
            primaryAfter.name,
            primaryAfter.lastError?.message
          );
        }
      }
    } catch (error) {
      const manager = getManager();
      const server = manager?.getPrimaryServerForFile(absolutePath);
      if (server?.state === 'error') {
        maybeNotifyMissingServer(absolutePath, ctx, 'edit', server.name, server.lastError?.message);
      }
      // Logged inside the manager; swallow here to keep the hook non-disruptive.
      void error;
    }
  });
}
