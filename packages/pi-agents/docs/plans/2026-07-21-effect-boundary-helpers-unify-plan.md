# Effect Boundary Helpers Unify Implementation Plan

**Goal:** Deduplicate the post–Effect-adoption Promise-boundary patterns (`tryPromise` + Exit rethrow as-is, continue-after-failure serial tails) into `effect-runtime`, wire them into `run-store` / `run-coordinator` / `chain`, and document when to use each runner.

**Inputs:** Code review of `@balaenis/pi-agents` Effect adoption (2026-07-21); `docs/effect-adoption/01-phase-0-conventions.md`; current `src/effect-runtime.ts`, `src/run-store.ts` (`runSerial`), `src/run-coordinator.ts` (`enqueueDurableWrite`), `src/chain.ts` (`runFanoutWorkers`).

**Assumptions:**

- Public Promise/sync APIs and wire error shapes (`RunStoreError` plain `{ code, message }`, `instanceof Error` paths) stay unchanged.
- Do **not** migrate `interactive-agent` queues, `session-lease.acquireTails`, worktree Either left shapes, or ArtifactStoreError → TaggedError in this plan.
- Abort helpers (`failIfAborted` / `failAgentAbortError`) remain available; this plan only documents that Promise-pool paths may keep boolean `signal?.aborted` checks (no forced production wiring).
- One shared **keyed** serial executor covers both coordinator map tails and run-store per-run queues; run-store keeps `assertValidRunId` outside the shared helper.

**Architecture:** Extend the leaf `effect-runtime` bridge with two orthogonal primitives: (1) `runEffectThrowingAsIs` — Exit → throw preserving non-Error failures; (2) `createKeyedSerialExecutor` — continue-after-failure Promise tails with swallowed map entries. Call sites replace inlined copies. `runEffectPromise` stays the Error-wrapping façade for domain Effect modules (`artifact-store`, `session-lease`, lock sleep).

**Tech Stack:** TypeScript, Bun, `effect@^3.22.0`, existing `bun:test` suites, Mise (`mise run typecheck|test --package packages/pi-agents`).

---

## File Map

- Modify: `packages/pi-agents/src/effect-runtime.ts` — add as-is runner, tryPromise helper, keyed serial executor; document runner choice
- Modify: `packages/pi-agents/tests/effect-runtime.test.ts` — unit coverage for new helpers
- Modify: `packages/pi-agents/src/run-store.ts` — `runSerial` uses shared executor; drop local Cause/Exit rethrow block if unused
- Modify: `packages/pi-agents/src/run-coordinator.ts` — `enqueueDurableWrite` uses shared executor; drop local rethrow block if unused
- Modify: `packages/pi-agents/src/chain.ts` — fanout worker body uses `runEffectThrowingAsIs` + `tryPromiseUnknown` (or equivalent); keep pool scheduler local
- Modify: `packages/pi-agents/docs/effect-adoption/01-phase-0-conventions.md` — boundary runner choice table + abort usage note
- Optional small: `packages/pi-agents/src/run-store.ts` — `sleepLockRetry` use `Duration.millis` if already importing Effect (no new deps)

## Tasks

### Task 1: Boundary helpers in `effect-runtime`

**Outcome:** Callers can (a) run Effects while rethrowing typed failures as-is, (b) wrap a Promise factory as `Effect.Effect<A, unknown>`, (c) enqueue keyed serial work with continue-after-failure semantics — without duplicating Cause unpacking.

**Files:**

- Modify: `packages/pi-agents/src/effect-runtime.ts`
- Modify: `packages/pi-agents/tests/effect-runtime.test.ts`

**Steps:**

- [ ] Export `tryPromiseUnknown<A>(work: () => Promise<A>): Effect.Effect<A, unknown>` as:

  ```ts
  Effect.tryPromise({ try: work, catch: (cause) => cause });
  ```

- [ ] Export `runEffectThrowingAsIs<A, E>(effect: Effect.Effect<A, E>): Promise<A>`:

  1. `const exit = await runEffectExit(effect)`
  2. Success → return `exit.value`
  3. Failure → `Cause.failureOption` present → **throw that value as-is** (Error **or** plain object)
  4. Else first `Cause.defects` entry → throw that value as-is
  5. Else `throw new Error(Cause.pretty(exit.cause))`

  Must **not** wrap plain object failures in `Error` (contrast `runEffectPromise` / `causeToRejection`).

- [ ] Export `createKeyedSerialExecutor()` returning:

  ```ts
  {
    enqueue<T>(key: string, task: () => Promise<T>): Promise<T>
  }
  ```

  Semantics (match current coordinator + run-store):

  - Per-key tail starts as `Promise.resolve()` when missing
  - Task body: `runEffectThrowingAsIs(tryPromiseUnknown(task))`
  - Chain: `prev.then(runTask, runTask)` (continue after previous success **or** failure)
  - Map stores **swallowed** promise: `next.then(() => undefined, () => undefined)` so unhandled rejections never wedge
  - Return the **non-swallowed** `next` to the awaiter
  - No automatic key deletion (coordinator keeps late non-active writes serial)

- [ ] Document in module comments (short table):

  | Helper                  | Non-Error typed failure         | Use when                                                                |
  | ----------------------- | ------------------------------- | ----------------------------------------------------------------------- |
  | `runEffectPromise`      | wrap in `Error`                 | domain Effects whose public Promise API should only reject with `Error` |
  | `runEffectThrowingAsIs` | rethrow as-is                   | store/coordinator/fanout where plain `{ code, message }` must survive   |
  | `runEffectExit`         | never throws for typed failures | callers that branch on Exit                                             |

- [ ] Unit tests:

  - `runEffectThrowingAsIs`: success value
  - `runEffectThrowingAsIs`: `Effect.fail(err)` rejects with **same** Error instance
  - `runEffectThrowingAsIs`: `Effect.fail({ code: 'run_busy', message: 'x' })` rejects with **same object** (not `instanceof Error`)
  - `runEffectPromise` still wraps string/plain non-Error (existing tests)
  - `createKeyedSerialExecutor`: serial order for same key (task2 starts after task1 settles)
  - `createKeyedSerialExecutor`: rejected task1 does **not** prevent task2 from running; task2 awaiter still gets its own result
  - `createKeyedSerialExecutor`: different keys may run concurrently (start task B while A is pending; resolve A after B started)

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/effect-runtime.test.ts`
- Expected: All tests pass (existing + new).
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.

### Task 2: Wire `run-store.runSerial`

**Outcome:** `runSerial` uses the shared keyed executor; local Exit rethrow copy is gone; `assertValidRunId` still runs before enqueue.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`

**Steps:**

- [ ] Import `createKeyedSerialExecutor` from `./effect-runtime.ts` (keep `runEffectPromise` for lock sleep).
- [ ] Replace `queues` / `getQueue` / inline `runTask` with one module-level or factory-scoped executor, e.g. `const serial = createKeyedSerialExecutor()`.
- [ ] `runSerial` becomes:

  ```ts
  function runSerial<T>(runId: string, task: QueuedTask<T>): Promise<T> {
    assertValidRunId(runId);
    return serial.enqueue(runId, task);
  }
  ```

- [ ] Remove unused `Cause` / `Exit` / `Option` / `runEffectExit` imports if nothing else in the file needs them.
- [ ] Keep `RunQueue` type only if still referenced; otherwise delete.
- [ ] Optional: `sleepLockRetry` → `runEffectPromise(Effect.sleep(Duration.millis(bounded)))` with `Duration` import from `effect` (behavior unchanged).

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: All pass (same count order of magnitude as pre-change; 0 fail).
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

### Task 3: Wire `run-coordinator.enqueueDurableWrite`

**Outcome:** Durable write queue uses the same serial executor; comments still describe continue-after-failure + plain object rethrow, pointing at `effect-runtime`.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`

**Steps:**

- [ ] Import `createKeyedSerialExecutor` from `./effect-runtime.ts`.
- [ ] Replace `durableWriteTails` + inline `runTask` with `const durableWrites = createKeyedSerialExecutor()`.
- [ ] `enqueueDurableWrite` becomes:

  ```ts
  function enqueueDurableWrite<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return durableWrites.enqueue(runId, work);
  }
  ```

- [ ] Preserve comment that tails are **not** cleared in `unregisterRun` (executor has no delete — document that intentional retention is by design of the shared helper).
- [ ] Remove unused Effect Cause/Exit/Option imports if no longer needed in this file.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-coordinator.test.ts`
- Expected: All pass, 0 fail.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

### Task 4: Wire `chain` fanout worker body only

**Outcome:** Fanout worker Promise body uses shared as-is runner; pool claim/stopScheduling logic stays local (not a serial queue).

**Files:**

- Modify: `packages/pi-agents/src/chain.ts`

**Steps:**

- [ ] Import `runEffectThrowingAsIs` and `tryPromiseUnknown` from `./effect-runtime.ts`.
- [ ] Replace `runOne` body with:

  ```ts
  const runOne = (item: TIn, index: number): Promise<TOut> =>
    runEffectThrowingAsIs(tryPromiseUnknown(() => worker(item, index)));
  ```

- [ ] Keep concurrency clamp, claim, stopScheduling, onUnstarted, firstError rethrow unchanged.
- [ ] Update Phase 7 comment to reference `runEffectThrowingAsIs` instead of inlined Cause unpacking.
- [ ] Remove unused Cause/Exit/Option/Effect imports if the file no longer needs them (if Effect is unused after this, drop the `effect` import entirely).

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/chain.test.ts`
- Expected: All pass, 0 fail.

### Task 5: Conventions doc

**Outcome:** Phase 0 conventions state the two Promise runners and when abort helpers apply.

**Files:**

- Modify: `packages/pi-agents/docs/effect-adoption/01-phase-0-conventions.md`

**Steps:**

- [ ] Under **Boundary rules**, add the runner choice table from Task 1 (names must match exports).
- [ ] Note: `createKeyedSerialExecutor` is the standard continue-after-failure queue for durable write paths; do not re-inline `prev.then(run, run)` for new durable serial work.
- [ ] Under **Abort / interrupt**, add: production Promise-pool schedulers may keep point-in-time `signal?.aborted` checks; use `failIfAborted` only inside Effect programs. Do not wrap pure Promise pools solely to call abort helpers.
- [ ] Mark `checkAbortSignal` as compatibility alias of `failIfAborted` (prefer the latter at new call sites) — already true in code; ensure doc matches.

**Validation:**

- Run: `git diff --check -- packages/pi-agents/docs/effect-adoption/01-phase-0-conventions.md packages/pi-agents/src/effect-runtime.ts`
- Expected: No whitespace errors.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/effect-runtime.test.ts tests/run-store.test.ts tests/run-coordinator.test.ts tests/chain.test.ts`
- Expected: All pass, 0 fail.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `hk fix` then `hk check` on touched paths (or repo-wide if that is the project habit)
- Expected: Clean for touched files.
- Optional full suite: `mise run test --package packages/pi-agents`
- Expected: Pass if time allows; focused suites above are the merge gate.

## Failure Behavior

- Typed plain-object failures from store/coordinator must still reject awaiters with the **same object** after unification; regression here is a ship blocker.
- One rejected serial task must not prevent later tasks on the same key (continue-after-failure).
- Invalid `runId` still fails in `assertValidRunId` **before** enqueue (run-store only).

## Privacy and Security

- No change to run storage layout, lock protocol, artifact paths, or trust boundaries.

## Rollout Notes

- Internal refactor only; no public API or README usage change required.
- Safe as a single PR on `feat/effect-boundary-helpers` (or worktree under `./.worktrees`).

## Risks and Mitigations

- **Semantic drift on rejection wrapping** — unit tests pin plain-object identity for `runEffectThrowingAsIs`; keep `runEffectPromise` wrap tests.
- **Import cycles** — `effect-runtime` must stay free of domain imports beyond existing `AgentAbortError` type import; serial helper stays in the leaf.
- **Over-sharing with interactive-agent** — explicitly out of scope; do not export delete/reset APIs until a second caller needs them.

## Open Questions

None. Scope locked to boundary helper extraction + three call sites + conventions doc.

## Out of Scope

- `interactive-agent` / `session-lease` Promise tails
- worktree Either left-type unification
- ArtifactStoreError → `Data.TaggedError`
- Wiring `failIfAborted` into execution/fanout production paths
- Effect Schema / `@effect/platform-node` / Layer DI
- Strict-tx rewrite
