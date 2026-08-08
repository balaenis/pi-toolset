# Implementation Plan

**Goal:** Add deterministic `stopIf` conditions to sequential chain steps so a schema-valid result can end a chain successfully without launching the predeclared tail.

**Inputs:** The observed run `run-f783814f-9b32-497d-a15a-2638c77848ea`, the current chain schema and executor, durable run and resume code, bundled workflow prompts, and the confirmed product decisions in this session.

**Assumptions:**

- `stopIf` is valid only on sequential steps.
- The Version 1 API is `{ path: string, equals: JSON value }`.
- `path` is an RFC 6901 JSON Pointer into schema-validated structured output.
- `stopIf` requires `outputSchema`.
- Equality is deep JSON equality. It does not coerce types.
- A matched durable stop is permanent. Explicit continuation can reopen the executed prefix but cannot cross the stopped boundary.
- The confirmed test seams are the public `agent` chain request, durable `run.json` and resume behavior, and existing TUI chain details.

**Architecture:** Evaluate `stopIf` after structured output validation and named-output registration. A match completes the current step, persists a durable chain-stop marker, marks the never-started tail as skipped, and returns the stopping output as a successful chain result. Restore and resume use the marker as authoritative workflow state, so queued or skipped tail units cannot become resume targets.

**Tech Stack:** TypeScript, TypeBox, Bun test, Pi agent tool execution, Version 1 JSON run records, RFC 6901 JSON Pointer.

---

## Scope

### In Scope

- Optional `stopIf` on sequential chain steps.
- Deep comparison against validated structured output.
- Inline and artifact-backed structured output.
- Successful early completion with retained named output.
- Additive Version 1 durable stop state.
- Permanent tail skipping during restore, resume, and explicit continuation.
- Existing chain-detail rendering with `completed` and `skipped` statuses.
- Bundled reviewer and workflow prompt adoption.
- README, how-to, and reference updates.

### Out of Scope

- `stopIf` on fanout steps or fanout workers.
- JSONPath, truthiness, inequalities, expressions, or compound conditions.
- A general loop or branch expression language.
- Deleting tail topology or tail units.
- A new execution status.
- Migration of existing run records.
- Changes to single or parallel modes.

## Public Contract

```ts
{
  agent: 'reviewer',
  task: 'Return the requested structured review result.',
  name: 'review',
  outputSchema: {
    type: 'object',
    properties: {
      clean: { type: 'boolean' },
      standards: { type: 'array', items: { type: 'string' } },
      spec: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['clean', 'standards', 'spec', 'summary'],
    additionalProperties: false,
  },
  stopIf: {
    path: '/clean',
    equals: true,
  },
}
```

Rules:

- The empty string points to the structured-output root.
- Pointer escapes follow RFC 6901: `~0` means `~`, and `~1` means `/`.
- Missing or invalid pointers fail closed.
- A mismatch continues to the next step.
- A match returns success and does not set a failure or cancellation status.
- `stopIf` values are part of the stored request. Users must not put secrets in them.

## Durable Contract

Add one optional field to the existing Version 1 workflow state:

```ts
interface WorkflowChainStopState {
  step: number;
  reason: 'stopIf';
}

workflowState?: {
  fanouts: Record<string, WorkflowFanoutState>;
  chainStop?: WorkflowChainStopState;
};
```

Invariants:

- `step` is a positive one-based sequential chain step.
- The request step declares both `outputSchema` and `stopIf`.
- In a terminal stopped run, the stopping unit is `completed` and has a terminal result.
- During explicit continuation, units at or before `step` can use normal active or interrupted states. The marker remains valid while the executed prefix runs again.
- Static units after `step` are always `skipped` with no attempts.
- No fanout expansion or fanout child exists after `step`.
- Writing the same marker is idempotent.
- Writing a different marker is a conflict.
- The marker does not duplicate the pointer, comparison value, or structured output.

## File Map

### Public API and execution

- Modify: `packages/pi-agents/src/shared/schema.ts` — add the sequential `stopIf` input shape.
- Modify: `packages/pi-agents/src/output/json-pointer.ts` — expose deep JSON equality beside the existing pointer reader.
- Modify: `packages/pi-agents/src/output/output.ts` — classify `stop_condition_error` as a failure reason.
- Modify: `packages/pi-agents/src/execution/chain.ts` — validate, evaluate, stop successfully, restore the boundary, and invoke the awaited durability hook.
- Modify: `packages/pi-agents/src/execution/tool.ts` — wire stop persistence and restored stop state into chain execution.

### Persistence and resume

- Modify: `packages/pi-agents/src/run/run-types.ts` — define `WorkflowChainStopState`.
- Modify: `packages/pi-agents/src/run/run-coordinator.ts` — atomically persist and mirror the marker and skipped tail.
- Modify: `packages/pi-agents/src/run/run-store.ts` — validate marker topology and unit invariants.
- Modify: `packages/pi-agents/src/run/resume.ts` — exclude the protected tail from resume and continuation targets.
- Modify: `packages/pi-agents/src/index.ts` — do not advertise selective resume for a completed stopped run.

### Reviewer and workflow prompts

- Modify: `packages/pi-agents/agents/reviewer.md` — permit schema-requested JSON aggregation instead of mandatory Markdown headings.
- Modify: `packages/pi-agents/prompts/implement-plan.md` — use bounded static rounds with structured reviews and `stopIf`.
- Modify: `packages/pi-agents/prompts/review-loop.md` — use the same bounded structured stop contract.
- Modify: `packages/pi-agents/prompts/implement-loop.md` — use the same bounded structured stop contract.

### Tests

- Modify: `packages/pi-agents/tests/execution/chain.test.ts` — chain-result behavior and restored evaluation.
- Modify: `packages/pi-agents/tests/execution/tool.test.ts` — public tool behavior and durable stop persistence.
- Modify: `packages/pi-agents/tests/run/run-coordinator.test.ts` — strict marker write, idempotency, and state mirroring.
- Modify: `packages/pi-agents/tests/run/run-store.test.ts` — durable marker validation and Version 1 compatibility.
- Modify: `packages/pi-agents/tests/run/resume.test.ts` — permanent boundary behavior.
- Modify: `packages/pi-agents/tests/output/render.test.ts` — completed stop plus skipped tail presentation.
- Create: `packages/pi-agents/tests/config/bundled-prompts.test.ts` — shipped reviewer and workflow prompt contracts.

### Documentation

- Modify: `packages/pi-agents/README.md` — feature summary and durable behavior.
- Modify: `packages/pi-agents/docs/how-to.md` — practical review-chain example.
- Modify: `packages/pi-agents/docs/reference.md` — complete API, errors, persistence, and resume semantics.

## Seams

- **Seam:** Public `agent` chain request — verifies accepted input, pre-launch rejection, launch suppression, returned output, and durable result.
- **Seam:** `runChainWorkflow` result — verifies structured condition behavior, named-output retention, and logical statuses without testing a private evaluator directly.
- **Seam:** Durable `run.json` through `RunStore` — verifies the additive marker, topology invariants, and old Version 1 compatibility.
- **Seam:** Public `agent({ runId, task? })` resume behavior — verifies crash recovery and permanent tail exclusion.
- **Seam:** Existing TUI chain details — verifies completed and skipped states without adding a status.
- **Seam:** Shipped agent and prompt assets — verifies that bundled workflows request structured reviewer output and attach `stopIf` to every clean gate.

## Tasks

### Task 1: Accept and Validate the Sequential API

**Seam:** Public `agent` chain request.

**Outcome:** Sequential steps accept `{ stopIf: { path, equals } }`; a step without `outputSchema` fails before child launch.

**Files:**

- Modify: `packages/pi-agents/src/shared/schema.ts`
- Modify: `packages/pi-agents/src/output/output.ts`
- Modify: `packages/pi-agents/src/execution/chain.ts`
- Test: `packages/pi-agents/tests/execution/tool.test.ts`

**Steps:**

- [ ] **Red:** Add a tool test named `rejects stopIf without outputSchema before launch`.
- [ ] Submit a two-step chain whose first sequential step has `stopIf` but no `outputSchema`.
- [ ] Assert no child launches, the first logical step fails, the second is skipped, and the public result contains `stop_condition_error` with `stopIf requires outputSchema`.
- [ ] **Green:** Add optional `stopIf` only to `SequentialChainItem`.
- [ ] Define `path` as a string and `equals` as a JSON-compatible value. Validate values recursively; reject non-finite numbers and non-JSON values.
- [ ] Add one public request case at a time for `NaN`, an object with an `undefined` member, and a non-JSON value supplied through the direct TypeScript tool seam. Confirm each case fails before launch, then add only the validation needed for that case.
- [ ] Add a pre-launch cross-field check in `runSequentialStep` after `outputSchema` shape parsing and before task dispatch.
- [ ] Add `stop_condition_error` to the existing failure classification.
- [ ] Keep invalid `outputSchema` under `structured_output_error`.
- [ ] Do not add `stopIf` to `FanoutChainItem`.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/execution/tool.test.ts -t "rejects stopIf without outputSchema before launch"`
- Expected: the child launches or no dedicated failure exists.
- Run (green): the same command.
- Expected: zero launches and the dedicated failure passes.

### Task 2: Stop on a Deep Structured Match

**Seam:** `runChainWorkflow` result.

**Outcome:** A match completes the current step, preserves its named output, skips the tail, and returns its output successfully.

**Files:**

- Modify: `packages/pi-agents/src/output/json-pointer.ts`
- Modify: `packages/pi-agents/src/execution/chain.ts`
- Test: `packages/pi-agents/tests/execution/chain.test.ts`

**Steps:**

- [ ] **Red:** Add a three-step tracer test named `completes early when stopIf deeply matches structured output`.
- [ ] Give step 2 a name, `outputSchema`, and a pointer with `~0` and `~1` escapes.
- [ ] Compare a nested array or object whose object-key insertion order differs from the result.
- [ ] Assert only steps 1 and 2 launch; step 2 is completed; step 3 is skipped; the named text and structured output remain available; `isError` is absent; returned content is step 2 output.
- [ ] **Green:** Reuse `readJsonPointer` and add iterative deep JSON equality. Arrays are ordered; object key order is ignored; types are not coerced; `0` and `-0` are equal.
- [ ] Use one evaluation order: after `runStep` returns and structured validation has completed, build and register the named output, obtain the structured value from the inline result or trusted artifact resolver, evaluate `stopIf`, then invoke durability and return. Do not cache a separate condition result during terminal postprocessing.
- [ ] On match, call `markLaterSkipped` and return `{ done: true }` without `isError`.
- [ ] On mismatch, preserve the current `{ done: false }` path.
- [ ] Return the stopping result through `getResultParentOutput` so inline and artifact-backed final text keep existing behavior.
- [ ] Add follow-up red-green cases one at a time for mismatch continuation, root pointer `""`, ordered arrays, non-coercion (`true` versus `1`), and `0` versus `-0`. Each case must fail for its specific missing behavior before the minimal implementation is added.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/execution/chain.test.ts -t "completes early when stopIf deeply matches structured output"`
- Expected: step 3 launches and its output becomes the chain result.
- Run (green): the same command.
- Expected: two launches, retained named output, and a skipped tail.

### Task 3: Fail Closed When the Condition Cannot Be Evaluated

**Seam:** `runChainWorkflow` result.

**Outcome:** Invalid pointers and unavailable or invalid structured data fail before any tail launch.

**Files:**

- Modify: `packages/pi-agents/src/execution/chain.ts`
- Test: `packages/pi-agents/tests/execution/chain.test.ts`

**Steps:**

- [ ] **Red:** Add a table-driven test named `fails closed when stopIf cannot be evaluated`.
- [ ] Start with an invalid pointer. Assert `stop_condition_error`, current-step failure, skipped tail, and no later `runStep`; then add the minimum failure conversion.
- [ ] Repeat the red-green cycle one case at a time for a missing property, invalid array index, missing structured data, missing artifact resolver, and resolver failure.
- [ ] Assert diagnostics identify the category but do not print the resolved value or `equals` value.
- [ ] Keep the condition evaluator private to the chain module.
- [ ] Convert pointer and trusted-resolution failures to one bounded `stop_condition_error` shape.
- [ ] Preserve existing `structured_output_error` behavior when fresh model output fails parse or schema validation.
- [ ] Defer marker-aware restored-step recovery and restored schema revalidation to Task 8, after the durable marker and resume contract exist.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/execution/chain.test.ts -t "fails closed when stopIf cannot be evaluated"`
- Expected: one or more cases continue or return the wrong failure class.
- Run (green): the same command.
- Expected: every case fails closed with zero tail launches.

### Task 4: Define and Validate Durable Stop State

**Seam:** Durable `run.json` through `RunStore`.

**Outcome:** Valid additive markers load; malformed or contradictory markers return `corrupt_run`; old records remain valid.

**Files:**

- Modify: `packages/pi-agents/src/run/run-types.ts`
- Modify: `packages/pi-agents/src/run/run-store.ts`
- Test: `packages/pi-agents/tests/run/run-store.test.ts`

**Steps:**

- [ ] **Red:** Add a tracer test named `validates additive Version 1 chain stop state` with one valid stopped record and one invalid non-positive step.
- [ ] **Green:** Add optional `workflowState.chainStop` without changing `RUN_RECORD_VERSION`, and add only enough validation for the tracer.
- [ ] Add one red-green case at a time for an invalid reason, non-integer step, a fanout stop step, missing `outputSchema`, missing `stopIf`, missing stopping unit, an invalid terminal stopped record, attempted tail unit, and tail fanout state.
- [ ] For terminal `completed` records, require the stopping unit to be completed. For active or interrupted continuation records, permit normal states only for units at or before the marker; always require the protected tail to remain unattempted and skipped.
- [ ] Validate canonical unit IDs from `step` and the request topology rather than storing a duplicate unit ID in the marker.
- [ ] Assert an older Version 1 record without `chainStop` keeps current behavior.
- [ ] Do not infer a marker from old presentation-only `skipped` states.
- [ ] Preserve `fanouts: {}` when a stopped chain has no fanout expansion.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/run/run-store.test.ts -t "validates additive Version 1 chain stop state"`
- Expected: unknown marker data currently loads.
- Run (green): the same command.
- Expected: valid and legacy records load; malformed records fail.

### Task 5: Add the Strict Durable Stop Operation

**Seam:** Durable `run.json` through `RunCoordinator` and `RunStore`.

**Outcome:** The coordinator can atomically persist an idempotent marker, current chain details, and an unattempted skipped tail.

**Files:**

- Modify: `packages/pi-agents/src/run/run-coordinator.ts`
- Test: `packages/pi-agents/tests/run/run-coordinator.test.ts`

**Steps:**

- [ ] **Red:** Add one coordinator seam test for the first `persistChainStop` write. Assert the marker, current named outputs and logical statuses, and skipped tail reach disk and the live snapshot together.
- [ ] **Green:** Introduce `persistChainStop(runId, request)` with this storage-facing request:

  ```ts
  interface PersistChainStopRequest {
    step: number;
    reason: 'stopIf';
    details: SubagentDetails;
  }
  ```

- [ ] Clone `details` at the coordinator boundary. Do not retain a mutable chain-owned object.
- [ ] Serialize the operation through the existing durable write queue.
- [ ] In one strict update, verify the completed stop unit, verify the tail is never started, mark static tail units `skipped` without adding attempts, reject tail fanout state, write the marker, and persist the supplied details snapshot.
- [ ] Mirror the committed marker, units, and cloned details to live state only after disk success.
- [ ] **Red:** Add a second cycle for an identical write, then implement idempotency.
- [ ] **Red:** Add a third cycle for a conflicting step, then reject it without mutation.
- [ ] **Red:** Add a fourth cycle that performs a later fanout or ordinary workflow-state flush, then preserve `chainStop` in every merge, clone, mirror, and assignment path.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/run/run-coordinator.test.ts -t "persists chain stop"`
- Expected: no strict stop operation exists.
- Run (green): the same command after each cycle.
- Expected: first write, idempotency, conflict rejection, and marker preservation pass.

### Task 6: Connect Early Stop to Durable Success

**Seam:** Public `agent` chain request and durable `run.json`.

**Outcome:** A matching durable chain awaits the strict operation before it reports successful completion.

**Files:**

- Modify: `packages/pi-agents/src/execution/chain.ts`
- Modify: `packages/pi-agents/src/execution/tool.ts`
- Modify: `packages/pi-agents/src/run/run-coordinator.ts`
- Test: `packages/pi-agents/tests/execution/tool.test.ts`

**Steps:**

- [ ] **Red:** Add a foreground tool test named `persists stopIf before durable early success` for a three-step chain that matches at step 2.
- [ ] Assert the returned result is successful; only two agents launch; run status is `completed`; units 1 and 2 are completed; unit 3 is skipped with no attempts; `workflowState.chainStop` is present; named output and logical statuses are durable.
- [ ] **Green:** Add this storage-agnostic hook to `RunChainWorkflowOptions`:

  ```ts
  interface ChainStopRequest {
    step: number;
    reason: 'stopIf';
    details: SubagentDetails;
  }

  onChainStop?: (request: ChainStopRequest) => Promise<void>;
  ```

- [ ] Build the details snapshot only after the stop step is completed, its named output is registered, and the logical tail is skipped.
- [ ] Pass the snapshot to `onChainStop`; await it before returning `{ done: true }`.
- [ ] Wire the hook through fresh and restored durable contexts to `persistChainStop`.
- [ ] Make status derivation treat a valid marker-protected skipped tail as completed. Preserve current cancelled and resumable behavior for skipped units without a marker.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/execution/tool.test.ts -t "persists stopIf before durable early success"`
- Expected: the marker is absent, the tail remains queued, or status remains running.
- Run (green): the same command.
- Expected: completed run, committed marker, and unattempted skipped tail.

### Task 7: Preserve Strict Failure Semantics

**Seam:** Public `agent` chain request.

**Outcome:** Marker persistence failure never produces a successful early-stop result.

**Files:**

- Modify: `packages/pi-agents/src/execution/chain.ts`
- Modify: `packages/pi-agents/src/execution/tool.ts`
- Test: `packages/pi-agents/tests/execution/tool.test.ts`

**Steps:**

- [ ] **Red:** Add a fault-injected test named `does not report success when stopIf persistence fails`.
- [ ] Fail the strict stop-marker update after the stopping agent completes.
- [ ] Assert the tail does not launch, the tool result is an error with `stop_condition_error`, no partial marker exists, and normal failed-finalization and claim-release rules apply.
- [ ] **Green:** Convert awaited hook failures to a bounded stop-condition failure while retaining the stopping result and named output in details.
- [ ] Do not retry through a coalesced best-effort write.
- [ ] Do not include structured output or comparison values in the error.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/execution/tool.test.ts -t "does not report success when stopIf persistence fails"`
- Expected: success leaks or the error escapes without the required result shape.
- Run (green): the same command.
- Expected: dedicated error, no tail launch, and no partial marker.

### Task 8: Make Resume Respect the Permanent Boundary

**Seam:** Public `agent({ runId, task? })` resume behavior.

**Outcome:** Crash recovery can finalize a committed stop, and explicit continuation never launches protected tail steps.

**Files:**

- Modify: `packages/pi-agents/src/execution/chain.ts`
- Modify: `packages/pi-agents/src/execution/tool.ts`
- Modify: `packages/pi-agents/src/run/resume.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Test: `packages/pi-agents/tests/run/resume.test.ts`
- Test: `packages/pi-agents/tests/execution/tool.test.ts`

**Steps:**

- [ ] **Red:** Add resume inspection tests named `excludes chain stop tail units from resume targets`.
- [ ] Assert marker-protected skipped units are not incomplete targets; a completed stopped run still requires continuation; a stale running or interrupted record with a committed marker can finalize without dispatch.
- [ ] **Green:** Add `chainStop?: WorkflowChainStopState` to `RestoredChainState` and pass it from `maybeResumeDurableRun` before chain reconstruction.
- [ ] Extend `inspectResumeRecord` to derive a protected-tail unit set from the validated request and marker before it computes incomplete units or resume targets.
- [ ] Extend `reopenCompletedUnitsForResume` and `incrementIncompleteAttempts` to accept that protected set. They must never reopen or increment protected units.
- [ ] Apply the same protected set before session cleanup, continuation-delivery selection, and `isRunResumable` or aggregate resumability decisions.
- [ ] Force restored logical steps after the marker to `skipped` and make the main loop terminate at the stored boundary instead of resetting those steps to queued.
- [ ] If a completed stopping step has `stopIf` but no marker, resolve and revalidate its stored structured output, evaluate the condition, and persist the marker before dispatching a tail step. This closes the unit-complete/marker-write crash window.
- [ ] Keep records without a marker and without a recoverable completed stop condition on the existing path.
- [ ] **Red:** Add public tool scenarios named `permanently skips a stopIf tail on resume and continuation`.
- [ ] Cover a crash after marker persistence but before finalization and explicit continuation of a completed stopped run.
- [ ] Assert crash recovery launches no child and finalizes completed.
- [ ] Assert continuation reopens only completed prefix units, keeps the original marker, never launches or increments tail units, and returns the latest stopping-step output.
- [ ] **Green:** Make completed-unit reopening marker-aware. The persisted marker remains authoritative and is not re-evaluated to cross the boundary.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/run/resume.test.ts -t "excludes chain stop tail units from resume targets"`
- Expected: skipped tail units remain resume targets.
- Run (green): the same command.
- Expected: only the executed prefix participates.
- Run (red): `bun test packages/pi-agents/tests/execution/tool.test.ts -t "permanently skips a stopIf tail on resume and continuation"`
- Expected: the tail is queued, attempted, or launched.
- Run (green): the same command.
- Expected: the boundary remains permanent.

### Task 9: Preserve Existing TUI Status Semantics

**Seam:** Existing TUI chain details.

**Outcome:** The stopping step renders completed and the tail renders skipped without fake result rows or a new status.

**Files:**

- Test: `packages/pi-agents/tests/output/render.test.ts`
- Modify only if required: `packages/pi-agents/src/output/render.ts`

**Steps:**

- [ ] **Red:** Add a renderer test named `renders a completed stopIf step with its skipped tail`.
- [ ] Use details with a completed prefix, completed stopping step, skipped sequential tail, and skipped fanout logical tail.
- [ ] Assert collapsed and expanded views show existing completed and skipped treatments, keep the topology total, and do not fabricate execution-unit rows for unstarted tail steps.
- [ ] **Green:** Prefer no renderer change. If the test exposes an omission, make the smallest change that correctly renders the existing `skipped` status.
- [ ] Do not add `stopped` or `early-completed` to `ExecutionStatus`.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/output/render.test.ts -t "renders a completed stopIf step with its skipped tail"`
- Expected: skipped logical steps are omitted or mislabeled if a gap exists.
- Run (green): the same command.
- Expected: current statuses render correctly.

### Task 10: Adopt the Contract in Bundled Review Workflows

**Seam:** Shipped agent and prompt assets.

**Outcome:** Bundled implementation and review workflows use deterministic clean gates and no longer rely on free-form `Clean` text to control a static chain.

**Files:**

- Modify: `packages/pi-agents/agents/reviewer.md`
- Modify: `packages/pi-agents/prompts/implement-plan.md`
- Modify: `packages/pi-agents/prompts/review-loop.md`
- Modify: `packages/pi-agents/prompts/implement-loop.md`
- Create: `packages/pi-agents/tests/config/bundled-prompts.test.ts`

**Steps:**

- [ ] **Red:** Add a shipped-asset test that reads all three workflow prompts and the reviewer definition.
- [ ] Assert each clean-gate review declares the common structured schema and `stopIf: { path: '/clean', equals: true }`.
- [ ] Assert each `stopIf` review also declares `outputSchema`.
- [ ] Assert prompts no longer claim that an unbounded loop can execute inside a static chain.
- [ ] Assert the reviewer definition permits JSON-only aggregation when the task includes a structured-output contract, while preserving `## Standards` and `## Spec` for ordinary review calls.
- [ ] **Green:** Update `reviewer.md` with two explicit output modes:
  - Ordinary call: current Markdown headings and summary.
  - Schema-requested call: aggregate sub-review findings into the requested JSON only. The runtime skips heading completion checks when `outputSchema` is active.
- [ ] Use one common review result shape in all workflow prompts: `clean: boolean`, `standards: string[]`, `spec: string[]`, `blockers: string[]`, and `summary: string`.
- [ ] Set `clean` true only when both finding arrays and `blockers` are empty. Preserve implementation blockers as standalone strings; do not ask the reviewer to invent a blocker.
- [ ] Replace the impossible unbounded-loop instruction with these exact bounded topologies:
  - `implement-plan.md`: `implement` (general) → `review-1` (reviewer, stop gate) → `fix-plan-1` (planner from `{outputs.review-1}`) → `implement-2` (general from `{outputs.fix-plan-1}`) → `review-2` (reviewer, stop gate) → `fix-plan-2` (planner from `{outputs.review-2}`) → `implement-3` (general from `{outputs.fix-plan-2}`) → `review-3` (reviewer, final stop gate).
  - `review-loop.md`: `review-1` (reviewer, stop gate) → `fix-plan-1` (planner) → `implement-1` (general) → `review-2` (reviewer, stop gate) → `fix-plan-2` (planner) → `implement-2` (general) → `review-3` (reviewer, final stop gate).
  - `implement-loop.md`: `context` (explore) → `plan` (planner from `{outputs.context}`) → `implement-1` (general from `{outputs.plan}`) → `review-1` (reviewer, stop gate) → `fix-plan-1` (planner) → `implement-2` (general) → `review-2` (reviewer, stop gate) → `fix-plan-2` (planner) → `implement-3` (general) → `review-3` (reviewer, final stop gate).
- [ ] Give every review step the common `outputSchema`, a unique `name`, and `stopIf: { path: '/clean', equals: true }`.
- [ ] Include the preceding implementation report, preceding review, and preceding fix plan in each later task through the exact named placeholders above. This preserves blocker evidence across rounds.
- [ ] If `review-3` is not clean, end normally with its remaining findings, actual blockers, and `summary` stating that the configured review-round limit was reached. Do not promise another round or fabricate a blocker map.
- [ ] Keep validation, permission, no-progress, and no-fake-completion rules.
- [ ] Start the new TypeScript test file with two `ABOUTME:` lines.

**Validation:**

- Run (red): `bun test packages/pi-agents/tests/config/bundled-prompts.test.ts`
- Expected: current prompts use prose-only clean checks and claim an unbounded loop.
- Run (green): the same command.
- Expected: all shipped contracts are deterministic and bounded.

### Task 11: Document the API and Operational Semantics

**Seam:** Published package documentation.

**Outcome:** Users can configure, diagnose, and resume stopped chains without reading source.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/how-to.md`
- Modify: `packages/pi-agents/docs/reference.md`

**Steps:**

- [ ] Add a concise README example and feature note.
- [ ] Add a how-to recipe for stopping a review/fix chain when `/clean` equals `true`.
- [ ] Document the exact shape, `outputSchema` requirement, root pointer, escaping, equality rules, sequential-only scope, named-output retention, and returned output.
- [ ] Document `stop_condition_error` cases and the rule that diagnostics do not echo compared values.
- [ ] Document `workflowState.chainStop`, completed run status, skipped tail units, strict persistence ordering, and permanent resume boundary.
- [ ] State that old Version 1 records are not migrated and retain current behavior.
- [ ] Update the bundled-workflow section to describe three bounded review gates.

**Validation:**

- Run: `hk check`
- Expected: Markdown, ESLint, and Prettier checks pass.

## Final Validation

Run in this order:

1. `mise run test --package packages/pi-agents`
   - Expected: all package tests pass, including chain, durable, resume, prompt, and rendering regressions.
2. `mise run typecheck --package packages/pi-agents`
   - Expected: `stopIf` is available only on sequential steps and all marker accesses are type-safe.
3. `mise run build --package packages/pi-agents`
   - Expected: package bundling and postbuild gates pass; bundled assets remain included.
4. `hk check`
   - Expected: repository ESLint and Prettier checks pass.

Manual checks:

- Inspect one successful durable fixture. Confirm `workflowState.chainStop` contains only `step` and `reason`.
- Confirm every bundled `stopIf` review also declares `outputSchema`.
- Confirm no source adds `stopIf` to fanout schema.
- Confirm no new execution status exists.
- Confirm a condition mismatch continues, a match succeeds, and evaluation or persistence failures fail.

## Failure Behavior

| Condition                                  | Required behavior                              |
| ------------------------------------------ | ---------------------------------------------- |
| `stopIf` without `outputSchema`            | Fail before launch with `stop_condition_error` |
| Invalid `outputSchema`                     | Preserve existing `structured_output_error`    |
| Fresh structured parse or schema failure   | Preserve existing `structured_output_error`    |
| Invalid or missing JSON Pointer target     | Fail closed with `stop_condition_error`        |
| Structured artifact unavailable or corrupt | Fail closed with `stop_condition_error`        |
| Restored value fails its stored schema     | Fail closed with `stop_condition_error`        |
| Deep equality mismatch                     | Continue to the next step                      |
| Deep equality match                        | Complete successfully at the current step      |
| Strict marker write fails                  | Return an error and never report early success |
| Conflicting marker                         | Fail closed                                    |
| Malformed marker                           | `RunStore.getRun` returns `corrupt_run`        |
| Legacy Version 1 record                    | Load with existing behavior                    |
| Resume or continuation after a marker      | Never launch the protected tail                |

## Privacy and Security

- Evaluate only JSON data. Do not execute expressions or user code.
- Reuse the own-property JSON Pointer reader. Do not traverse prototypes.
- Use the trusted artifact resolver and existing digest, media-type, run-ID, and path checks.
- Use iterative equality to avoid stack exhaustion on deeply nested values.
- Do not serialize values solely for comparison.
- Do not include structured output or comparison values in diagnostics.
- Persist only the stop boundary. The request already stores the condition.
- Treat durable run storage as sensitive per-user data under the existing policy.

## Rollout Notes

- Keep `RUN_RECORD_VERSION` at `1`; the marker is optional and additive.
- Ship engine support and bundled prompt adoption in the same package release.
- No migration or feature flag is required.
- Chains without `stopIf` follow the unchanged path.
- Release notes must state sequential-only scope, the `outputSchema` requirement, successful early completion, permanent durable boundaries, and Version 1 compatibility.

## Risks and Mitigations

- **Queued tails make a successful run appear running.** — Persist skipped tails and make final status derivation marker-aware.
- **Ordinary workflow-state flushes erase the marker.** — Preserve `chainStop` in every coordinator merge, clone, mirror, and fanout write path.
- **A crash occurs after unit completion but before marker persistence.** — Re-evaluate restored completed stop steps that do not yet have a marker.
- **A crash occurs after marker persistence but before finalization.** — Permit marker-proven recovery to finalize without dispatch.
- **Continuation reopens protected units.** — Exclude the tail from targets, attempt increments, continuation delivery, and restored queue reset.
- **Artifact externalization removes inline data.** — Evaluate fresh output before spill and resolve trusted refs on restore.
- **Reviewer system instructions conflict with JSON output.** — Add an explicit schema-requested output mode to the bundled reviewer.
- **Static prompts still imply a real loop.** — Use three bounded review gates and disclose the bound.
- **Object key order causes false mismatch.** — Compare own key sets and values independently of insertion order.
- **Deep values exhaust the call stack.** — Use an iterative worklist.

**Open Questions:** None.
