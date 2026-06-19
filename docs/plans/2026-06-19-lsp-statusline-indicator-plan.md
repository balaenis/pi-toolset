# LSP StatusLine Indicator Implementation Plan

**Goal:** Show a passive, non-interactive LSP health indicator in Pi's statusLine that reflects the current snapshot of lazily-started LSP servers — how many are running, starting, or failed — and updates in real time as server states change (including async crash-restart and startup retry/recovery transitions).

**Inputs:** User request on 2026-06-19 (UX discussion). Display format like `LSP ⚡ 2`. Constraints from the user: non-interactive (pure status display); LSP server processes are lazily started when a matching file is edited or the `lsp` tool is used; a failed server _will_ be retried, so its state can change over time — the indicator must therefore be a live snapshot, not a tombstone. Current-code correction: server instances themselves are **not** passively discovered over time; `session_start` calls `initializeManager(ctx.cwd)`, and `src/manager.ts` creates one instance per configured/autodetected server during async initialization. Repository evidence from `src/types.ts`, `src/instance.ts`, `src/manager.ts`, `src/index.ts`.

**Assumptions:**

- Do not display `ready/total`. The current implementation knows configured/autodetected server instances after manager initialization, but most instances remain `stopped` until a matching file/tool call triggers startup. Counting those stopped, never-used servers as a denominator would create noise and suggest work has happened when it has not. The indicator is therefore a live runtime snapshot, not a configuration summary.
- The indicator counts the running set as the primary number, surfaces failures as a separate `✗N` count (red), and optionally surfaces in-flight startups as `…N` (dim).
- `stopped` and `stopping` are non-interesting states for display purposes and are not counted.
- When all tracked counts are zero (session start, no matching file/tool use yet, or only `stopped`/`stopping` servers remain), the indicator is hidden entirely (clear the status key) rather than showing `LSP 0`, to avoid noise.
- The statusLine renderer supports per-segment color and Unicode glyphs via `ctx.ui.setStatus(key, text)`. **Confirmed:** the built-in footer (`dist/modes/interactive/components/footer.js`) renders extension status strings raw — it only sanitizes control chars, does NOT strip ANSI, and does NOT wrap the text in a flat theme color. The TUI is ANSI-aware (`docs/tui.md`). So per-segment color is achieved by embedding ANSI via `ctx.ui.theme.fg(colorName, text)` directly in the `setStatus` string — **no `setFooter` custom component is required.**

**Architecture:** The single-server state machine in `src/instance.ts` currently mutates a closure-local `let state` at 7 sites with no notification when state changes. The core change is to route every state mutation through a single `setState()` setter that fires an `onStateChange` callback. `src/manager.ts` aggregates per-instance state-change signals into a single manager-level subscription (`onServersChanged`). `src/index.ts` (the Pi extension entry) subscribes to that signal and renders the aggregated counts via `ctx.ui.setStatus('lsp', …)`. This is genuinely event-driven and requires no polling — critically, it captures async crash recovery (`restartOnCrash`) and other state-changing recovery paths without waiting for the next status render opportunity. Current-code correction: the existing `-32801` ContentModified backoff in `sendRequest()` does **not** change `LspServerState`; it should not be treated as a statusLine transition or test case.

**Tech Stack:** TypeScript, Pi extension API (`ctx.ui.setStatus`), Bun test (`bun:test`; `mise run test` runs `bun test`), existing `mise` tasks (`mise run typecheck`, `mise run test`, `mise run build`, `hk check`).

## Current-Code Audit Corrections

- Server instance discovery is eager during manager initialization; only process startup is lazy. Keep the UI as a runtime snapshot, not a `ready/total` configuration summary.
- `createLSPServerInstance` already uses its third argument for `LSPClientFactory`, and existing tests depend on that. Add `onStateChange` as a fourth argument (or an options object), not as the third argument.
- `session_shutdown` should unsubscribe the status listener and clear `ctx.ui.setStatus('lsp', undefined)` before `shutdownManager()` can trigger additional state changes. The shutdown handler can accept `ctx`.
- The `-32801` retry loop is a request-level retry while the server remains `running`; do not include it in status transition claims or tests.
- Tests should use `bun:test`, matching the existing suite and `.mise/tasks/test`.
- The crash-state test can capture the `onCrash` callback passed to a fake `LSPClientFactory` and invoke it directly; no real child process is needed.

---

## State → Display Mapping

| Display bucket        | Renders as  | `LspServerState` (`src/types.ts:6`) | Color   |
| --------------------- | ----------- | ----------------------------------- | ------- |
| ready (primary count) | `LSP ⚡ N`  | `running`                           | default |
| starting (in-flight)  | `…N` suffix | `starting`                          | dim     |
| failed                | `✗N` suffix | `error`                             | red     |
| (not counted)         | —           | `stopped`, `stopping`               | —       |

### Render rules

```
LSP ⚡ 2          only running                         steady state, plain
LSP ⚡ 2 …1       at least one starting                transient, self-updating
LSP ⚡ 2 ✗1       at least one error                   red ✗, disappears when retry succeeds
(hidden)       all tracked counts are zero          setStatus('lsp', undefined)
```

The failed count is a _live snapshot_: because a failed server is retried (crash auto-restart or `error → starting → running`), `✗1` must disappear once recovery succeeds. This is why event-driven refresh (not edit-triggered refresh) is required.

---

## File Map

- Modify: `src/instance.ts` — route all 7 `state = …` mutations through a single `setState(next)` setter; add an optional `onStateChange` callback as a fourth factory parameter because the existing third parameter is `clientFactory` and is used by tests.
- Modify: `src/manager.ts` — when constructing each `LSPServerInstance`, pass the state-change callback; expose a manager-level `onServersChanged(listener)` subscription plus a `getStateCounts()` helper that returns `{ running, starting, error }` over `getAllServers()`.
- Modify: `src/index.ts` — on `session_start`, subscribe to `onServersChanged` and render `ctx.ui.setStatus('lsp', …)`; keep the unsubscribe at module scope; on `session_shutdown`, unsubscribe and clear the status key before shutting down the manager.
- Create: `src/statusline.ts` — pure formatter: given `{ running, starting, error }` and a `theme.fg`-style color function, return the display string (or `undefined` when all tracked counts are zero). Keeps formatting testable; the color function is injected so the formatter has no hard dependency on the TUI. (ABOUTME header required.)
- Modify: `README.md` — document the LSP statusLine indicator, its format, the meaning of `…N` / `✗N`, and that it is a passive live runtime snapshot.
- Test: `tests/statusline.test.ts` — Bun unit coverage for the formatter across all bucket combinations (zero → hidden, running-only, with starting, with error, mixed). Inject an identity/marker `fg` stub so assertions verify which segment got which color without depending on real ANSI codes.
- Test: `tests/instance-state-change.test.ts` — Bun coverage that `onStateChange` fires on each transition (start success, start failure, stop, crash→error). For crash→error, capture the fake client's `onCrash` callback and invoke it directly.

## Implementation Detail

### `src/instance.ts` — single state mutation funnel

Replace the bare `let state` mutations with a setter so all transitions notify exactly once. Add the callback as a **fourth** factory parameter; the third parameter is already `clientFactory` and existing tests rely on it:

```ts
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
  clientFactory: LSPClientFactory = createLSPClient,
  onStateChange?: (state: LspServerState) => void
): LSPServerInstance {
  let state: LspServerState = 'stopped';

  function setState(next: LspServerState): void {
    if (next === state) return;
    state = next;
    onStateChange?.(next);
  }

  // ...
}
```

Then replace each of the 7 assignment sites (`error`, `starting`, `running`, `error`, `stopping`, `stopped`, `error`) with `setState('…')`. Keep the public instance surface minimal; no `server.onStateChange()` method is needed unless the fourth-argument approach becomes awkward.

### `src/manager.ts` — aggregation + subscription

- On server creation, pass a fourth-argument state-change callback that calls the manager's internal `notifyServersChanged()`.
- Add `getStateCounts(): { running: number; starting: number; error: number }` iterating `servers.values()`; do not expose or render a `total` denominator from configured-but-stopped servers.
- Add `onServersChanged(listener: () => void): () => void` (returns an unsubscribe). Keep a simple listener set; no external deps. Clear the set during `shutdown()` as a defensive cleanup, though `src/index.ts` should unsubscribe before calling `shutdownManager()`.

### `src/index.ts` — render

```ts
let unsubscribeLspStatus: (() => void) | undefined;

pi.on('session_start', (_event, ctx) => {
  initializeManager(ctx.cwd);

  const manager = getManager();
  if (!manager) return;

  const render = () =>
    ctx.ui.setStatus(
      'lsp',
      formatLspStatus(manager.getStateCounts(), (color, text) => ctx.ui.theme.fg(color, text))
    );

  unsubscribeLspStatus?.();
  unsubscribeLspStatus = manager.onServersChanged(render);
  render(); // initial hidden state while all counts are zero
});

pi.on('session_shutdown', async (_event, ctx) => {
  unsubscribeLspStatus?.();
  unsubscribeLspStatus = undefined;
  ctx.ui.setStatus('lsp', undefined);

  await shutdownManager();
  diagnostics.resetAll();
});
```

`formatLspStatus(counts, fg)` lives in `src/statusline.ts` and returns `undefined` when all tracked counts are zero (so `setStatus` clears the segment). It colors only the failure segment, e.g. `` `LSP ⚡ ${running} ${fg('error', `✗${error}`)}` ``, and dims the starting segment via `fg('dim', `…${starting}`)`. The confirmed footer behavior (raw ANSI passthrough, no flat color wrapper) makes this work in the built-in footer with no `setFooter`. Mirrors the official `examples/extensions/preset.ts` / `status-line.ts` pattern (`theme.fg(color, text)` per segment, concatenated).

## Validation

- `mise run typecheck` — types compile.
- `mise run test` — new formatter and state-change tests pass, existing suite green.
- `hk check` — eslint + prettier clean.
- Manual: edit a file matching a configured server → indicator appears as `LSP ⚡ 0 …1` while starting (if visible long enough), then `LSP ⚡ 1`; edit a file whose server is misconfigured → `✗1` in red; confirm a recovering server clears `✗` without further edits.

## Open Questions / Decisions Deferred

- Whether to render `starting` at all, or only count it once `running` (simpler, but loses the "it's coming" affordance). Plan keeps `…N` but it is the easiest piece to drop.
- Exact glyphs (`…` / `✗`) vs ASCII fallbacks — depends on confirmed statusLine font/Unicode support; formatter centralizes this so it is a one-line change.
- ~~Color application via `setStatus` vs `setFooter`.~~ **Resolved:** per-segment color works through `setStatus` by embedding `ctx.ui.theme.fg(color, text)` ANSI; the built-in footer passes ANSI through untouched. No `setFooter` needed.

## Stop Rules

- This document is a plan only; no source changes made yet.
- Color/Unicode capability of `setStatus` confirmed against `@earendil-works/pi-coding-agent` (footer renders raw ANSI; `theme.fg` per-segment coloring works). Ready to implement.
