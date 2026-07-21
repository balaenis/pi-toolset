# Phase 5: RunCoordinator Durable Write Queue

**Goal:** Replace `run-coordinator`’s hand-rolled `durableWriteTails` Promise chain with an Effect-backed per-run serial executor without changing coordinator public methods or coalesce/persist semantics.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md); `packages/pi-agents/src/run-coordinator.ts` (`enqueueDurableWrite`, `createRunCoordinator`); `packages/pi-agents/tests/run-coordinator.test.ts`.

**Assumptions:**

- Phase 0 complete; Phases 2–3 recommended (artifact/lease stability) but not hard-required if coordinator tests alone pass.
- `RunCoordinator` interface stays Promise/void as today (`persist` remains fire-and-forget; strict methods remain awaited Promises).
- Disk authority merge rules, fanout expand idempotency, sessionFile CAS, and finalize semantics are **not** redesigned — only the serial queue plumbing moves.

**Architecture:** Extract or inline a per-`runId` serial runner:

- Enqueue work so tasks for one run never overlap.
- A failed task must not permanently wedge the queue (today: `prev.then(() => work(), () => work())` then swallow on tail). Preserve that “continue after failure” property.
- `unregisterRun` still keeps tails for late non-active writes (do not delete queue entries eagerly if current code keeps them).

**Tech Stack:** `effect` (`Effect`, optionally `Queue` / `Deferred` / `Ref`), existing coordinator tests.

---

## File Map

- Modify: `packages/pi-agents/src/run-coordinator.ts` — serial queue implementation
- Optional create: `packages/pi-agents/src/serial-queue.ts` — reusable per-key serial executor (only if it reduces duplication with future run-store phase; default **inline first**, extract if >~40 lines duplicated later)
- Test: `packages/pi-agents/tests/run-coordinator.test.ts` — oracle
- Optional test: `packages/pi-agents/tests/serial-queue.test.ts` — only if extracted

## Behavioral Invariants

1. All durable writes for a given `runId` are strictly serial.
2. Queue continues after a rejected task (subsequent enqueues still run).
3. Coalesced `persist` timing (`DEFAULT_COALESCE_MS` / `coalesceMs`) unchanged.
4. Strict paths (`finishUnit`, `finalizeRun`, `persistSessionFile`, `persistAcpSessionId`, `persistInteractiveBinding`, `persistSessionPromptEstablished`, `persistContinuationDelivery`, `expandFanout`) still await durability as tests require.
5. `unregisterRun` clears timers/active map but does not break in-flight/late serial work (match current comments/tests).
6. No change to fingerprint, unit id helpers, or pure status derivation.

## Tasks

### Task 1: Capture queue contract from current code

**Outcome:** Implementer can reimplement without semantic drift.

**Files:**

- Read: `packages/pi-agents/src/run-coordinator.ts` around `durableWriteTails` / `enqueueDurableWrite`

**Steps:**

- [ ] Note exact continuation-on-error behavior of the tail Promise.
- [ ] Note whether the map entry is updated to a swallowed promise (yes today).
- [ ] List all call sites of `enqueueDurableWrite` / equivalent.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-coordinator.test.ts`
- Expected: Baseline green (may be long).

### Task 2: Implement Effect serial executor

**Outcome:** `enqueueDurableWrite` uses Effect (or a tiny serial-queue helper) with identical guarantees.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Optional create: `packages/pi-agents/src/serial-queue.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Optional: `packages/pi-agents/tests/serial-queue.test.ts`

**Steps:**

- [ ] Implement per-key serial run:
  - Input: `() => Promise<T>` or `Effect<T, unknown>`
  - Output: `Promise<T>` to the caller of that task
  - Ensure previous failure does not reject the next task’s scheduling
- [ ] Prefer:

  ```ts
  function enqueueDurableWrite<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return runEffectPromise(
      enqueueEffect(runId, Effect.tryPromise({ try: work, catch: (e) => e }))
    );
  }
  ```

  or keep Promise API on the queue helper.

- [ ] Do not change merge algorithms inside `persist` / `finalizeRun` / session field CAS in the same PR beyond what queue swap requires.
- [ ] If extracting `serial-queue.ts`, add unit tests: order preservation, continues after throw, per-key isolation.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-coordinator.test.ts`
- Expected: Pass.
- If extracted: `bun test tests/serial-queue.test.ts` — Expected: Pass.

### Task 3: Integration smoke with persistence paths

**Outcome:** Resume/tool paths that use coordinator still typecheck.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Optional before merge: `cd packages/pi-agents && bun test tests/resume.test.ts`
- Expected: Pass.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/run-coordinator.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `hk check` (touched paths)
- Expected: Clean.

## Failure Behavior

- A failed durable write still surfaces to its awaiting caller (strict methods).
- The per-run queue must accept new work after that failure.
- Do not convert strict failures into silent coalesce successes.

## Privacy and Security

- Coordinator persists prompts/outputs via store; no new logging.

## Rollout Notes

- Internal queue only; no on-disk change; no README.

## Risks and Mitigations

- Wedge queue on failure — explicit test if not already present; add regression in coordinator or serial-queue tests.
- Accidental parallel writes — property: overlapping `updateRunStrict` for same runId must not interleave (existing tests + optional stress).
- Large PR touching merge logic — reject scope creep in review.

## Open Questions

- Whether to extract `serial-queue.ts` now or wait until Phase 8 `runSerial` — default: extract only if Phase 5 implementation is clearly reusable without abstraction astronomy.
