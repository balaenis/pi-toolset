# Phase 7: Chain Fanout Concurrency Scheduler

**Goal:** Replace fanout’s `mapWithConcurrencyLimit` scheduling with Effect bounded concurrency while preserving restore, skip-completed, abort, structured-output, and progress snapshot semantics.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md), [02-phase-1-pure-leaves.md](./02-phase-1-pure-leaves.md); `packages/pi-agents/src/chain.ts` (`runFanoutStep`); `packages/pi-agents/src/execution.ts` (`mapWithConcurrencyLimit`); `packages/pi-agents/tests/chain.test.ts`.

**Assumptions:**

- Phases 0–1 complete; Phase 5–6 recommended.
- `runChainWorkflow` public signature stays `Promise<ChainResult>`.
- Sequential step path can remain Promise-based in this phase.
- `ChainRunStep` remains `(req) => Promise<SingleResult>` (workers are still Promise functions).
- Global `mapWithConcurrencyLimit` used by parallel mode in `tool.ts` is **not required** to migrate in this phase (optional follow-up); fanout can call a local Effect scheduler or a shared helper without forcing tool parallel migration.

**Architecture:** Inside `runFanoutStep`, schedule worker slots with `Effect.forEach` / `Effect.all` + `concurrency` option (or equivalent), converting each worker with `Effect.tryPromise`. Honor `AbortSignal` via Phase 0/6 helpers. Keep slot arrays, coalesced updates, and durable restore branches intact — only the waiter/pool changes.

**Tech Stack:** `effect` concurrency, existing chain tests, `MAX_CONCURRENCY` / `MAX_FANOUT_ITEMS` from `constants.ts`.

---

## File Map

- Modify: `packages/pi-agents/src/chain.ts` — fanout scheduler only
- Optional modify: `packages/pi-agents/src/execution.ts` — extract shared concurrency helper only if both fanout and parallel benefit without behavior change
- Test: `packages/pi-agents/tests/chain.test.ts` — oracle (large)
- Optional: `packages/pi-agents/tests/execution.test.ts` — only if `mapWithConcurrencyLimit` changes

## Behavioral Invariants

1. Concurrency clamped to `[1, MAX_CONCURRENCY]` (default `MAX_CONCURRENCY` when unspecified).
2. Restored completed fanout units are not re-run.
3. Abort cancels outstanding work and marks slots cancelled with abort result semantics (`getAbortResult` / `ABORT_MESSAGE`).
4. Structured output validation still applied via `postprocessTerminal`.
5. Progress updates: structural transitions immediate; content partials coalesced (`RESULT_UPDATE_INTERVAL_MS`).
6. Empty fanout completion evidence rules unchanged.
7. Fanout expansion durability hooks (`onExpandFanout` / restored mapping) unchanged.
8. Collect output / previousOutput plumbing unchanged.

## Tasks

### Task 1: Isolate scheduler seam

**Outcome:** Fanout worker pool is a single function call that can be swapped.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`

**Steps:**

- [ ] Locate `mapWithConcurrencyLimit(renderedTasks, concurrency, worker)` in `runFanoutStep`.
- [ ] Extract local helper in `chain.ts` or shared:

  ```ts
  async function runFanoutWorkers<T>(
    items: T[],
    concurrency: number,
    signal: AbortSignal | undefined,
    worker: (item: T, index: number) => Promise<SingleResult>
  ): Promise<SingleResult[]>;
  ```

  Initial implementation may still call `mapWithConcurrencyLimit` (mechanical seam only).

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/chain.test.ts`
- Expected: Pass after seam extract (no behavior change).

### Task 2: Effect bounded concurrency implementation

**Outcome:** Worker pool uses Effect concurrency; tests still pass.

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`
- Optional: `packages/pi-agents/src/execution.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Implement `runFanoutWorkers` with Effect, e.g.:

  ```ts
  return runEffectPromise(
    Effect.forEach(
      items.map((item, index) => ({ item, index })),
      ({ item, index }) =>
        Effect.tryPromise({
          try: () => worker(item, index),
          catch: (e) => e as unknown,
        }),
      { concurrency }
    )
  );
  ```

  Adjust error channel so abort errors propagate the same way as today’s `mapWithConcurrencyLimit` (inspect current abort/rethrow behavior in `runFanoutStep` try/catch around workers).

- [ ] Ensure mid-fanout `signal.aborted` still short-circuits or cancels per existing tests (match current skip/cancel behavior exactly).
- [ ] Do not change sequential `runSequentialStep` in this phase.
- [ ] Do not change template rendering beyond what Phase 1 already did.
- [ ] If changing shared `mapWithConcurrencyLimit`, run parallel tool tests too.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/chain.test.ts`
- Expected: Pass (restore, abort, concurrency, structured output, empty fanout, collect).

### Task 3: Parallel mode decision note

**Outcome:** Explicit choice recorded: migrate tool parallel now or later.

**Steps:**

- [ ] Default: **leave** `tool.ts` parallel path on `mapWithConcurrencyLimit`.
- [ ] If migrating: treat as extra task with `tests/tool.test.ts` validation; do not hide it inside fanout-only PR without mention.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/chain.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Recommended before merge: `mise run test --package packages/pi-agents`
- Expected: Pass (full package).

## Failure Behavior

- Worker throw that is abort → cancelled slots + chain abort semantics.
- Worker throw that is non-abort → existing fanout failure aggregation (do not invent fail-fast unless tests already require it).
- Effect defect must not replace structured `ChainResult` errors.

## Privacy and Security

- Fanout tasks may include sensitive item payloads; no new logging.

## Rollout Notes

- Internal scheduler; user-visible chain feature set unchanged; no README change.

## Risks and Mitigations

- Ordering of results vs slots — keep index-based slot writes inside worker (Effect.forEach order of completion must not scramble slot indices; workers already write `slots[index]`).
- Abort races with coalescer — keep `fanoutTerminal` latch.
- Large `chain.test.ts` runtime — use focused `-t` filters during iteration; full file before merge.

## Open Questions

None if tool parallel migration stays deferred.
