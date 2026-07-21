# Phase 2: Session Lease Internals

**Goal:** Reimplement `session-lease` acquire serialization and owner deferreds with Effect primitives while preserving the process-global store, sticky fail-closed release, and Promise public API.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md); `packages/pi-agents/src/session-lease.ts`; `packages/pi-agents/tests/session-lease.test.ts`; callers in `execution.ts`, `interactive-agent.ts`.

**Assumptions:**

- Phase 0 complete (`effect-runtime` available).
- Public functions stay Promise/sync:
  - `awaitSessionLease`
  - `acquireSessionLease` → `Promise<{ token, key, release }>`
  - `releaseSessionLeaseWithCertainty`
  - canonicalize / build key helpers remain pure sync
- `globalThis` + `Symbol.for` store identity remains required (Jiti reload safety).

**Architecture:** Keep the process-global `SessionLeaseStore` shape (or an equivalent Map pair). Replace hand-rolled `acquireTails` Promise chains and owner `done` deferreds with `Deferred` (and optionally a per-key serial Effect queue). Export surface still returns Promises via `runEffectPromise`. Canonical path helpers stay pure Node `fs` sync (no Effect FileSystem).

**Tech Stack:** `effect` (`Deferred`, `Effect`, `Ref` optional), existing lease tests.

---

## File Map

- Modify: `packages/pi-agents/src/session-lease.ts` — Effect-based acquire/release internals
- Modify: `packages/pi-agents/src/effect-runtime.ts` — only if a small shared helper is needed (prefer not)
- Test: `packages/pi-agents/tests/session-lease.test.ts` — oracle; extend only for regressions found

## Behavioral Invariants (must not break)

1. Empty key / empty session file → acquire returns no-op release; await is no-op.
2. Concurrent `acquireSessionLease` on the same key serializes install (only one owner at a time).
3. Success `release()` deletes the lease entry when token matches.
4. Failure `release(err)` sticky-rejects; later acquires await the rejected `done` and fail closed (must not install a new happy owner over a sticky failure without observing the rejection — preserve current semantics exactly as tests define).
5. Foreign `release` with wrong token is ignored.
6. Double release is ignored.
7. `awaitSessionLease(key, selfToken)` does not deadlock on self.
8. `disposalCertaintyFromCaught` / `releaseSessionLeaseWithCertainty` mapping unchanged (`dispose_failed` → sticky fail).
9. Test seams `getSessionLeaseStoreSizesForTest` / `getSessionLeaseGlobalKeyForTest` remain.

## Tasks

### Task 1: Map current algorithm to Effect primitives

**Outcome:** Written mapping in code comments (brief) so implementation does not invent new lease semantics.

**Files:**

- Modify: `packages/pi-agents/src/session-lease.ts` (comments only in this task, or combined with Task 2)

**Steps:**

- [ ] Identify current pieces:
  - `acquireTails: Map<string, Promise<void>>` → serial mutex per key
  - `leases: Map<string, SessionLeaseRecord>` with `done` Promise + `settle`
  - sticky reject via `done.catch(() => undefined)` to avoid unhandled rejection
- [ ] Choose implementation approach (pick one; default **A**):
  - **A (Recommended):** Keep Maps; replace owner `done` with `Deferred.make` + `Deferred.succeed` / `Deferred.fail`; keep acquire serialization as Effect `Enqueued` via per-key Deferred chain or retain Promise tail but construct it from Effect.
  - **B:** Per-key `Ref` + queue of waiters fully in Effect (larger change).
- [ ] Do not change canonicalize algorithms.

**Validation:**

- Run: none required if comments-only; otherwise continue to Task 2.

### Task 2: Implement Effect-backed acquire/release

**Outcome:** `acquireSessionLease` / `awaitSessionLease` use Effect internals; all existing tests pass.

**Files:**

- Modify: `packages/pi-agents/src/session-lease.ts`
- Test: `packages/pi-agents/tests/session-lease.test.ts`

**Steps:**

- [ ] Implement owner record with `Deferred<void, Error>` (or `Deferred<void, never>` + separate sticky error channel — **must match sticky fail tests**).
- [ ] `release(err?)`:
  - success: complete deferred successfully; delete map entry when token matches (same as today)
  - failure: fail deferred; **keep** map entry sticky
- [ ] Serialize acquire install so two concurrent acquires cannot both become owner.
- [ ] Bridge:

  ```ts
  export async function acquireSessionLease(...) {
    return runEffectPromise(acquireSessionLeaseEffect(...));
  }
  ```

  or keep async function body with localized `runEffectPromise` for sub-steps — either is fine if tests pass and conventions hold.

- [ ] Ensure rejected sticky promises do not surface as unhandled rejections (mirror `done.catch(() => undefined)`).
- [ ] Keep pure helpers (`canonicalizeSessionLeaseKey`, `buildSessionLeaseKey`, …) free of Effect.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/session-lease.test.ts`
- Expected: Full suite pass (serial acquire, sticky fail, foreign release, empty key, sizes seams).

### Task 3: Caller integration typecheck

**Outcome:** `execution.ts` / `interactive-agent.ts` compile without edits (preferred) or with import-only fixes.

**Files:**

- Modify callers only if required for types

**Steps:**

- [ ] Run typecheck and a thin execution/interactive subset if lease APIs changed structurally (they should not).

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `cd packages/pi-agents && bun test tests/session-lease.test.ts tests/execution.test.ts`
- Expected: Pass (execution exercises lease + dispose certainty). If full `execution.test.ts` is too slow in iteration, run focused lease-related tests first, then full file before merge.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/session-lease.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `hk check` on touched files / repo policy
- Expected: Clean.

## Failure Behavior

- Sticky `dispose_failed` must continue to block clean re-acquire until process semantics match tests (fail closed).
- Implementation bugs that drop serial acquire → race tests fail; do not “fix” by weakening tests.

## Privacy and Security

- Lease keys include cwd/session identity; no new logging of paths.

## Rollout Notes

- Internal-only; no README change.

## Risks and Mitigations

- Subtle sticky-fail drift — treat `session-lease.test.ts` as spec; add a regression test before changing semantics.
- Deadlock with self-await — keep `selfToken` short-circuit.
- Mixing Promise tails and Effect poorly — prefer one serialization mechanism per key.

## Open Questions

None if approach A is used. Approach B needs a short design note in the PR body only.
