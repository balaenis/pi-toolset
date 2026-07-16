# Subagent Result Memory Optimization Implementation Plan

**Goal:** Prevent long-running, multi-turn, and fanout subagent workflows from exhausting the parent Pi process heap while preserving snapshot isolation, durable resume semantics, and the current collapsed/expanded rendering behavior.

**Inputs:** The observed parent-process V8 heap OOM after approximately 5.9 million milliseconds, the memory-path analysis of `SingleResult.messages`, `cloneSingleResult()`, parallel/fanout aggregation, durable run persistence, and Pi session retention, plus local serialized-size and clone-cost measurements collected on 2026-07-16.

**Assumptions:**

- The mutable runtime transcript is an execution detail; parent tool details and durable unit results need only the assistant text/tool-call presentation used by current rendering, plus final output, status, usage, structured output, error, worktree, and session identity metadata.
- Raw history is reloadable only when a native session identity exists: Pi uses `sessionFile`; Grok ACP uses `acpSessionId` and `session/load`. If no reloadable identity exists, raw tool-result bodies are intentionally released after terminal projection rather than retained indefinitely in the parent process.
- Interactive Agent View endpoints bound all non-authoritative in-memory transcript payloads: finalized tool-result/display payloads are compacted per message even while active, while authoritative assistant text required by parent `finalOutput` is preserved. Oversized or LRU-detached reloadable idle transcripts are then evicted and marked unhydrated so the existing lazy hydrate path can reload the same bounded view on demand.
- Existing Version 1 run records and parent session entries containing full `messages` arrays must continue to load and render. New compact snapshots remain Version 1 and use additive fields, so this project does not require a durable schema-version migration.
- `finalOutput` and `structuredOutput` are workflow-significant and must not be truncated by this change. Presentation transcript items and diagnostic text may be bounded because they are non-authoritative display data.
- `snapshotSingleResult()` deep-freezes snapshot-owned `presentation` and cloned JSON-like `structuredOutput` payloads once. Aggregate emissions create new arrays, a fresh empty `messages` array, and mutable shell fields (`usage`, `fanout`, changed-file arrays) while sharing only those frozen payloads; exact deep-clone helpers remain available where mutable working state is required.
- No new user configuration is introduced initially. Fixed limits and update intervals will be documented constants; usage evidence can justify configuration later.

**Architecture:** Low-level executors keep returning private mutable results to `runStepWithContext`, but every callback crossing a runtime boundary receives a compact presentation snapshot. After completion checks, sequential/fanout structured-output postprocessing, status stamping, and worktree finalization, `runStepWithContext` becomes the terminal compaction boundary for workflow callers and durability. Compact snapshots store `finalOutput` and a bounded `ResultPresentation`, set `messages` to an empty legacy-compatible array, and support old records through message-derived fallback; Parallel/Chain aggregation uses copy-on-write result slots, high-frequency content updates are coalesced before snapshot creation, and idle Interactive Agent View transcripts are bounded or lazily evicted.

**Tech Stack:** TypeScript, Bun tests, Pi extension tool APIs, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, Grok ACP, Mise, ESLint, Prettier, and `hk`.

---

## Baseline Evidence

The implementation should preserve these measurements as the motivation and use synthetic fixtures to enforce equivalent regressions:

- The largest inspected parent Pi session was 50.42 MiB serialized; 47.73 MiB came from 40 `agent` tool-result `details` objects.
- In the largest inspected `SingleResult`, the serialized transcript was 3.69 MiB: 3.56 MiB of `toolResult` messages versus 0.12 MiB of assistant messages.
- Keeping assistant messages only reduced the inspected parent agent details from 47.73 MiB to 2.68 MiB (94.4%). Projecting only display text/tool calls reduced them to 1.29 MiB (97.3%).
- Applying the display projection to both `details.results` and `units[*].result` reduced the largest inspected pretty-printed `run.json` from 12.67 MiB to approximately 0.31 MiB without a schema change.
- On the largest inspected result, 40 `structuredClone()` operations averaged 6.17 ms per full transcript, 0.30 ms per assistant-only transcript, and 0.26 ms per display projection.
- Pi persists the final tool `details` in the parent `toolResult` message (`pi-agent-core/dist/agent-loop.js`) and `SessionManager.fileEntries` retains every appended entry in memory. Pi compaction changes LLM context construction but does not evict old entry objects from the parent heap.

## Scope Boundaries

### Included

- Compact presentation snapshots for running, terminal, abort, aggregate, and durable results.
- Backward-compatible rendering of legacy full-message results and new compact results.
- Removal of raw `toolResult` bodies from parent-side live result accumulation when no current consumer uses them.
- Copy-on-write Parallel and Chain/fanout result aggregation.
- Coalescing of high-frequency content updates with immediate terminal/status delivery.
- Bounded non-authoritative presentation transcript and diagnostic fields.
- Per-message bounded Interactive Agent View transcript projection during active runs, plus lazy rehydration after oversized/LRU idle eviction.
- Durable validation for the additive presentation shape and normalization of legacy results before the first post-claim resume write.
- Synthetic serialized-size, mutation-isolation, update-count, resume, and rendering regression tests.
- README and package documentation changes describing transcript ownership and retention.

### Deferred Follow-up

- A Version 2 durable schema that removes the remaining JSON duplication between `details.results` and `units[*].result`. Compact snapshots make that duplication small enough to defer safely.
- Changes to Pi core `SessionManager` for lazy entry loading or compacted-entry heap eviction.
- Automatic deletion or rewriting of historical parent sessions and inactive durable runs.
- Artifact externalization for arbitrarily large `finalOutput` or `structuredOutput`; these fields remain authoritative in this project.
- A configurable memory-limit surface. Fixed initial constants avoid expanding the public configuration contract before measurements justify it.

## File Map

- Create: `packages/pi-agents/src/result-snapshot.ts` — build compact, idempotent, mutation-isolated result snapshots and bound presentation-only fields.
- Create: `packages/pi-agents/src/update-coalescer.ts` — coalesce latest-value update callbacks with explicit immediate flush/cancel behavior and unref'd timers.
- Modify: `packages/pi-agents/src/types.ts` — add the additive `ResultPresentation` shape while retaining exact deep-clone helpers for mutable restoration paths.
- Modify: `packages/pi-agents/src/constants.ts` — define total/per-item presentation caps, diagnostic caps, update cadence, active interactive message caps, and retained-idle transcript limits.
- Modify: `packages/pi-agents/src/output.ts` — add result-aware final-output, latest-activity, and expanded-transcript helpers with legacy fallback.
- Modify: `packages/pi-agents/src/render.ts` — render compact `presentation` data first and legacy `messages` second, including an explicit omission marker.
- Modify: `packages/pi-agents/src/execution.ts` — keep low-level live results private, emit compact snapshots, stop retaining raw child tool-result bodies, and coalesce Grok ACP chunk updates.
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts` — compute usage from the full post-baseline view, retain only assistant messages in the live parent result, and emit compact snapshots.
- Modify: `packages/pi-agents/src/abort.ts` — carry a compact terminal snapshot without weakening abort-time isolation.
- Modify: `packages/pi-agents/src/tool.ts` — consume result-aware final output, compact terminal results before durability, and replace full Parallel clone cascades with copy-on-write snapshots.
- Modify: `packages/pi-agents/src/chain.ts` — restore compact/legacy results safely, use result-aware output helpers, replace aggregate deep clones with copy-on-write snapshots, and coalesce fanout partials.
- Modify: `packages/pi-agents/src/completion-check.ts` — use result-aware final-output access after terminal snapshots clear `messages`.
- Modify: `packages/pi-agents/src/run-coordinator.ts` — enforce compact unit-result storage and normalize actively resumed legacy records once before they enter the live registry.
- Modify: `packages/pi-agents/src/run-store.ts` — validate optional presentation metadata on details and unit results while accepting legacy results without it.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — track finalized transcript size, evict oversized/LRU idle transcripts after terminal publication, and reuse lazy hydration.
- Modify: `packages/pi-agents/README.md` — document compact parent/durable results, child-session ownership of raw tool results, and retention implications.
- Modify: `packages/pi-agents/docs/explanation.md` — explain mutable runtime results, compact presentation snapshots, update coalescing, and durable ownership.
- Modify: `packages/pi-agents/docs/reference.md` — define the new result-detail contract and transcript/diagnostic limits.
- Modify: `packages/pi-agents/docs/tutorials.md` — clarify what expanded output contains and where raw child history remains available.
- Create: `packages/pi-agents/tests/result-snapshot.test.ts` — projection, immutability, idempotence, truncation, and serialized-size coverage.
- Create: `packages/pi-agents/tests/update-coalescer.test.ts` — timer, latest-value, flush, cancel, and terminal-order coverage.
- Create: `packages/pi-agents/tests/memory-regression.test.ts` — synthetic large tool-result and eight-way fanout size/update regression coverage.
- Modify: `packages/pi-agents/tests/output.test.ts` — compact-presentation and legacy fallback helper coverage.
- Modify: `packages/pi-agents/tests/render.test.ts` — rendering parity and omission-marker coverage.
- Modify: `packages/pi-agents/tests/execution.test.ts` — Pi subprocess and Grok ACP snapshot/update behavior.
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts` — post-baseline usage plus assistant-only parent projection.
- Modify: `packages/pi-agents/tests/pi-rpc-integration.test.ts` — ensure transport/session behavior remains unchanged after transcript eviction.
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts` — active payload projection, exact byte accounting, terminal publication, idle eviction, lazy rehydration, and non-reloadable fallback behavior.
- Modify: `packages/pi-agents/tests/interactive-view.test.ts` — omission-marker rendering for bounded/hydrated endpoint transcripts.
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts` — synchronous settled-consumer ordering before deferred transcript eviction.
- Modify: `packages/pi-agents/tests/tool.test.ts` — terminal compaction, Parallel copy-on-write, update coalescing, and parent detail size.
- Modify: `packages/pi-agents/tests/chain.test.ts` — compact restoration, result-aware previous output, fanout copy-on-write, and throttled partials.
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts` — compact durable unit results and active legacy normalization.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — optional presentation validation and legacy Version 1 acceptance.
- Modify: `packages/pi-agents/tests/resume.test.ts` — resume from compact and legacy results without redispatch or output loss.

## Implementation Preflight

- Create a dedicated `fix/subagent-memory-optimization` branch in a fresh worktree under `./.worktrees` before changing production code.
- Start from the current repository commit, not from unrelated working-tree modifications.
- In the fresh worktree, run `mise install` and `bun install --frozen-lockfile` before baseline checks unless the worktree already has a valid linked development environment.
- Capture baseline focused test results for output/rendering, execution, Pi RPC, Chain/fanout, coordinator/store, resume, and Interactive Agent View before Task 1.
- Keep Tasks 1–4 independently reviewable: the presentation contract lands first, runtime/durable boundaries second, and clone-removal begins only after compact snapshot tests pass.

## Tasks

### Task 1: Define the Compact Presentation Contract

**Outcome:** `SingleResult` can represent a new compact presentation without raw messages, while every current rendering/output caller can consume either the new representation or a legacy full-message result.

**Files:**

- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/render.ts`
- Test: `packages/pi-agents/tests/output.test.ts`
- Test: `packages/pi-agents/tests/render.test.ts`

**Steps:**

- [ ] Add an additive `ResultPresentation` union with shared `transcript: DisplayItem[]` and optional `latestActivity: DisplayItem`, plus two valid states: untruncated with both `truncated`/`omittedItems` absent, or truncated with `truncated: true` and required positive `omittedItems`. The transcript contains ordered assistant text/tool-call items except the text selected as final output; latest activity is stored only when it cannot be derived from `finalOutput`.
- [ ] Add optional `presentation?: ResultPresentation` to `SingleResult`; keep `messages: Message[]` required so old fixtures and persisted Version 1 records remain structurally compatible.
- [ ] Keep `cloneSingleResult()` and `cloneResults()` as exact deep-clone operations. Update them to deep-clone `presentation` and retain their role for mutable restoration/isolation rather than compact delivery.
- [ ] Add `getResultFinalOutput(result)` to return `result.finalOutput` first and fall back to `getFinalOutput(result.messages)` for legacy or live results.
- [ ] Add `getResultLatestActivity(result)` with this precedence: explicit compact `latestActivity`; a synthesized text item from `finalOutput` when the latest text was intentionally de-duplicated; the final retained transcript item only as a defensive fallback for incomplete compact data; legacy `getLatestActivity(result.messages)` when `presentation` is absent. `snapshotSingleResult()` must therefore store an explicit latest item for every tool call or text that differs from `finalOutput`.
- [ ] Add `getResultTranscriptAndFinal(result)` to return presentation transcript plus result-aware final output, or derive both from legacy messages when `presentation` is absent.
- [ ] Update `getResultOutput()` to use `getResultFinalOutput()` in success, failure, and completion-check branches.
- [ ] Update `render.ts` to call only the result-aware helpers. If `presentation.truncated` is true, prepend one muted line such as `[Earlier transcript omitted: N items]` before the retained transcript.
- [ ] Add paired tests that construct one legacy result and one equivalent compact result and assert identical collapsed/expanded visible content except for the explicit omission marker when truncation is active.

**Validation:**

- Run: `bun test packages/pi-agents/tests/output.test.ts packages/pi-agents/tests/render.test.ts`
- Expected: Legacy and compact results produce the same final output, latest activity, ordered transcript, and expanded rendering; truncated presentation adds exactly one omission marker.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: All existing callers compile while both result representations are accepted.

### Task 2: Implement Compact, Idempotent Result Snapshots

**Outcome:** One helper converts a mutable live or legacy result into a compact snapshot that excludes raw child tool-result bodies, preserves all workflow-significant fields, and cannot be changed by later parser mutation.

**Files:**

- Create: `packages/pi-agents/src/result-snapshot.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Test: `packages/pi-agents/tests/result-snapshot.test.ts`

**Steps:**

- [ ] Start `result-snapshot.ts` with the required two-line ABOUTME header.
- [ ] Add `RESULT_PRESENTATION_MAX_BYTES = 512 * 1024` and `RESULT_PRESENTATION_ITEM_MAX_BYTES = 64 * 1024` to `constants.ts`. The total cap covers the serialized `presentation` object, including transcript and explicit latest activity; neither cap applies to authoritative `finalOutput`, `structuredOutput`, task text, session identity, or continuation data.
- [ ] Add `RESULT_DIAGNOSTIC_MAX_BYTES = 64 * 1024` for non-authoritative `stderr`, `errorMessage`, and `errorStack` snapshots.
- [ ] Implement deterministic display-item bounding before the total cap:
  - truncate oversized text items by UTF-8 bytes and include an omitted-byte marker within the per-item limit;
  - replace oversized tool-call argument objects with a small marker object containing omitted-byte count and child-session inspection guidance;
  - never store a text `latestActivity` when it is byte-for-byte identical to `finalOutput`; let the result-aware helper synthesize it.
- [ ] Implement `snapshotSingleResult(result)` with this order:
  1. Derive `finalOutput`, transcript, and latest activity from the source before clearing messages.
  2. Clone and per-item-bound display text/tool-call arguments so later parser mutation cannot alter the snapshot.
  3. Retain the newest presentation items whose complete UTF-8 JSON representation, including array/object overhead and explicit latest activity, fits `RESULT_PRESENTATION_MAX_BYTES`; count every omitted item and mark truncation.
  4. Copy result metadata, clone mutable shell fields (`usage`, `fanout`, changed-file arrays), clone and deep-freeze JSON-like `structuredOutput` plus `presentation` once, assign `finalOutput`, and set `messages: []`.
  5. Bound diagnostics deterministically: keep the tail of `stderr`, the prefix of `errorMessage`, and the prefix of `errorStack`, with each omission marker included inside the 64 KiB limit.
- [ ] Implement `snapshotResults(results)` as an ordered map over `snapshotSingleResult()`.
- [ ] Implement `copySnapshotShell(result)` for aggregate delivery: create a new top-level result, a fresh empty `messages` array, and cloned `usage`, `fanout`, and changed-file arrays while sharing only snapshot-owned frozen `presentation` and `structuredOutput` payloads.
- [ ] Make snapshotting idempotent: when a result already has empty `messages` and a valid `presentation`, return `copySnapshotShell(result)` without rebuilding or reserializing immutable payloads.
- [ ] Preserve `structuredOutput`, `errorCode`, and `stopReason` exactly; deterministically bound only `stderr`, `errorMessage`, and `errorStack`.
- [ ] Add tests proving that mutating the source message text, tool-call arguments, usage, fanout metadata, changed-file array, or structured output after snapshot creation does not change the snapshot.
- [ ] Add a synthetic result containing a 4 MiB `toolResult` message plus assistant text/tool calls; assert the raw payload is absent from the snapshot JSON, final output and bounded tool-call presentation remain present, and the serialized snapshot is below 128 KiB for that fixture.
- [ ] Add cap tests for oversized latest text, oversized tool-call arguments, complete presentation-object accounting, newest-item retention, final-output de-duplication, truncation state, and omitted count.

**Validation:**

- Run: `bun test packages/pi-agents/tests/result-snapshot.test.ts`
- Expected: Projection, isolation, idempotence, diagnostic bounds, and serialized-size assertions all pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: The new helper and presentation types compile without circular imports.

### Task 3: Apply Compact Snapshots at Runtime and Terminal Boundaries

**Outcome:** Low-level executors keep private mutable results only until `runStepWithContext` finishes all terminal postprocessing; mutable parser data never escapes into parent updates, workflow arrays, abort errors, or durable units, and Pi subprocess/Pi RPC parent projections stop retaining raw child tool-result bodies.

**Files:**

- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/abort.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/completion-check.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-integration.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`
- Test: `packages/pi-agents/tests/completion-check.test.ts`

**Steps:**

- [ ] Keep `runSingleAgent()`, `runSingleAgentGrokAcp()`, and `runSingleAgentPiRpc()` returning private live results to `runStepWithContext`; change their `onUpdate`/low-level terminal notification callbacks to emit `snapshotSingleResult(currentResult)`. Treat those low-level terminal notifications as provisional UI updates—the compact result returned or rethrown by `runStepWithContext` is the sole authoritative terminal/durable snapshot.
- [ ] Build update `content` from `getResultFinalOutput(snapshot)` instead of scanning `snapshot.messages`, which is empty by design.
- [ ] In the Pi subprocess parser, append a `message_end` payload only when `msg.role === "assistant"`; ignore user/tool-result `message_end` payloads and remove the separate `tool_result_end` append/update path. Test both Pi event encodings for tool results.
- [ ] Preserve native child persistence/process I/O when a session identity exists. If the invocation has no reloadable native session identity, document that ignored raw tool-result bodies are intentionally released after execution.
- [ ] In Pi RPC projection, calculate usage/model/stop reason from the complete post-baseline snapshot first, then assign only post-baseline assistant messages to `currentResult.messages` before creating the compact parent snapshot.
- [ ] Leave the Grok ACP parser's mutable assistant-message assembly private; every callback crossing out of execution must receive a compact snapshot.
- [ ] For sequential Chain steps, create and pass a `postprocessTerminal` callback analogous to the existing fanout callback. It must run `applyStructuredOutputValidation()`, terminal status assignment, and step identity stamping before `runStepWithContext` snapshots the result and calls `endUnit`.
- [ ] Keep an idempotent sequential fallback for injected test `runStep` stubs that ignore `postprocessTerminal`: copy the returned compact/live result into private mutable working state, apply the same postprocess, and resnapshot it rather than mutating a returned snapshot.
- [ ] Add one local `finalizeTerminalResult()` boundary in `runStepWithContext`: run completion checks, supplied sequential/fanout terminal postprocess, status assignment, and worktree finalization against private mutable working state; create one compact snapshot; pass it to `endUnit`; return it to the caller.
- [ ] Route every result-producing exit through that boundary, including unknown agent, context preparation, cwd, isolation, skill, worktree setup, runtime/transport, completion-check, structured-output, cancellation, and generic synthesized failures. No early failure may return or persist a live/raw result.
- [ ] Keep low-level `AgentAbortError` construction compact, then in the `runStepWithContext` abort catch create mutable working state with exact clone helpers, stamp worktree/postprocess/status metadata, create the authoritative compact terminal snapshot, call `endUnit`, and throw a replacement `AgentAbortError` carrying that final snapshot and the original abort origin.
- [ ] Ensure the replacement abort error, not the provisional low-level error object, is what Single/Parallel/Chain callers recover; do not mutate the low-level snapshot in place.
- [ ] Replace direct `getFinalOutput(result.messages)` calls that can observe terminal compact results with `getResultFinalOutput(result)` in `tool.ts`, `chain.ts`, and `completion-check.ts`.
- [ ] Add regression tests proving:
  - neither tool-result `message_end` nor `tool_result_end` events appear in parent result messages/details;
  - Pi usage and stop reason still update from assistant messages;
  - Pi RPC usage includes all post-baseline assistant messages even though parent messages are compacted;
  - completion checks, sequential/fanout JSON extraction, Chain `{previous}`, named outputs, and fanout source extraction still receive complete final/structured output;
  - a durable sequential structured-output seed can feed a fanout, survive interruption, and resume without losing `unit.result.structuredOutput`;
  - a provisional low-level abort update is superseded by the replacement authoritative abort result, which retains terminal status, error metadata, and worktree/session identity without raw tool-result bodies.

**Validation:**

- Run: `bun test packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/pi-rpc-execution.test.ts packages/pi-agents/tests/pi-rpc-integration.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/completion-check.test.ts`
- Expected: All runtimes preserve visible output, usage, terminal state, structured workflow behavior, abort metadata, and session identity while parent snapshots contain no raw tool-result messages.

### Task 4: Enforce Compact Durable Results and Normalize Active Legacy Runs

**Outcome:** Every newly written durable unit and presentation result is compact, while existing full-message Version 1 records remain readable and are normalized once only when they are actively resumed.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/resume.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Make `run-coordinator.finishUnit()` create a private compact shell first, then stamp run/unit/session/capability/status metadata onto that private object and assign it to `unit.result`; never mutate the result object supplied by the caller.
- [ ] In `maybeResumeDurableRun()`, immediately after the post-claim record is loaded and revalidated—and before cloning `units`, appending `run_resumed`, or performing the first `store.updateRun()`—normalize `record.details.results` and every existing `unit.result` with `snapshotSingleResult()` exactly once.
- [ ] Persist the normalized details and units in the same post-claim transition-to-running write, then register that normalized record in the coordinator so no resume write can reserialize legacy full transcripts first.
- [ ] Do not normalize records during `/agent runs`, `/agent status`, or other read-only listing/inspection paths; inactive historical files remain unchanged until an actual resume writes them.
- [ ] In Parallel restoration, normalize any selected legacy `unit.result` or `details.results` fallback before placing it in `allResults`.
- [ ] In Chain restoration, derive final/presentation data from legacy messages before clearing them, then preserve existing unit identity, structured output, named output, and frozen fanout mapping behavior.
- [ ] Add one reusable run-store validator for optional `presentation` and apply it to every `details.results[*]` and `units[*].result`:
  - `transcript` must be an array of text/toolCall display items;
  - text items must contain string `text`;
  - toolCall items must contain string `name` and a non-null, non-array object `args`;
  - `latestActivity`, when present, must satisfy the same display-item rules;
  - absent truncation requires absent `omittedItems`;
  - `truncated === true` requires a positive integer `omittedItems`;
  - `truncated: false`, non-positive counts, and a count without truncation are rejected.
- [ ] Continue accepting legacy results with populated `messages` and absent `presentation`; do not change `RUN_RECORD_VERSION`.
- [ ] Add a resume regression seeded with a full-message Version 1 single result; assert it resumes/returns the same final output and that the next persisted record contains compact `details.results` and `unit.result` snapshots.
- [ ] Add Parallel and Chain/fanout legacy-resume tests proving completed units remain skipped, structured outputs remain available, and compact normalization does not alter canonical unit/session identity.
- [ ] Add a synthetic durable-record size test with one 4 MiB raw tool-result message duplicated in details and unit result; after coordinator normalization, assert pretty-printed JSON is below 512 KiB for the fixture.

**Validation:**

- Run: `bun test packages/pi-agents/tests/run-coordinator.test.ts packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/chain.test.ts`
- Expected: New/actively resumed runs persist compact results, malformed presentation metadata fails as `corrupt_run`, and legacy Version 1 records retain resume/output behavior.

### Task 5: Replace Parallel and Chain Clone Cascades with Copy-on-Write Snapshots

**Outcome:** A worker update replaces only its own compact result slot; aggregate updates allocate a new ordered array/top-level result shells without deep-cloning every unchanged transcript and structured payload.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Treat results returned by `snapshotSingleResult()` as immutable internal snapshots. Do not mutate a received partial, terminal, abort, cancelled, skipped, or unstarted result in place; create a replacement object and use `copySnapshotShell()` for aggregate delivery.
- [ ] Audit and replace current in-place result mutations in Parallel and Chain/fanout status/step/fanout stamping paths, including cancellation and postprocess fallback branches, before sharing snapshot payloads.
- [ ] In Parallel mode, keep one result snapshot per stable input slot. Replace `cloneResults(allResults)` in `emitParallelUpdate()` with a new array of `copySnapshotShell()` results, which clones top-level metadata, `usage`, `fanout`, and changed-file arrays while sharing only snapshot-owned frozen `presentation` and `structuredOutput`.
- [ ] Preserve queued/running/terminal transitions by replacing the entire changed slot rather than editing the prior snapshot.
- [ ] Keep final Parallel ordering and model-visible output unchanged; final details must use the same copy-on-write snapshot policy without a second full deep clone.
- [ ] In Chain `buildDetails()`, replace `cloneResults(results)` with a new ordered array of `copySnapshotShell()` results and continue cloning mutable logical-step metadata and output records separately.
- [ ] Keep exact `cloneSingleResult()`/`cloneResults()` only where a restored durable result is about to become mutable working state; exact clones must deep-clone the additive `presentation` field.
- [ ] For fanout, maintain one compact snapshot per canonical item slot. A worker partial replaces only its item; prior sequential results and unchanged fanout items are reused.
- [ ] Ensure `finishUnit()` canonicalizes a private shell and does not mutate a snapshot also retained in a workflow array or previous parent update.
- [ ] Add mutation-isolation tests that retain an earlier emitted `details` object, apply later updates to the same worker and a sibling worker, and assert the retained array, statuses, presentation transcript, usage, fanout metadata, changed-file arrays, and structured output do not change.
- [ ] Add an eight-item out-of-order fanout test proving update allocation remains ordered and cumulative without calling the exact deep-clone helper for unchanged items. Use an injected spy/helper seam rather than wall-clock timing as the assertion.

**Validation:**

- Run: `bun test packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts`
- Expected: Earlier updates remain stable, task/item ordering is unchanged, every partial is cumulative, and unchanged compact result payloads are not deep-cloned again.

### Task 6: Coalesce High-Frequency Content Updates

**Outcome:** Grok ACP chunk streaming and concurrent fanout partials emit at a bounded cadence, while initial status, terminal status, errors, cancellation, and durable identity writes remain immediate and ordered.

**Files:**

- Create: `packages/pi-agents/src/update-coalescer.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Test: `packages/pi-agents/tests/update-coalescer.test.ts`
- Test: `packages/pi-agents/tests/execution.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`
- Test: `packages/pi-agents/tests/chain.test.ts`

**Steps:**

- [ ] Start `update-coalescer.ts` with the required two-line ABOUTME header.
- [ ] Add `RESULT_UPDATE_INTERVAL_MS = 150` to `constants.ts`, matching the current shared TUI spinner cadence without coupling the coalescer implementation to renderer internals.
- [ ] Implement a synchronous latest-value coalescer with `schedule()`, `flush()`, and `cancel()`:
  - The first scheduled update arms one timer.
  - Further schedules before expiry replace the pending value without adding timers.
  - Timer expiry emits the latest value exactly once.
  - `flush()` clears the timer and emits the latest pending value immediately.
  - `cancel()` clears the timer and discards pending work.
  - Timers call `unref()` when available.
- [ ] Allow timer injection so tests advance a deterministic fake clock and production uses `setTimeout`/`clearTimeout`.
- [ ] In Grok ACP execution, send initial running state immediately and coalesce message/tool/usage chunk updates before snapshot creation. On terminal/error/cancel, discard the pending running update and emit one immediate terminal snapshot containing the latest complete state; never emit pending-running followed by terminal solely because of shutdown.
- [ ] Do not add coalescing to Pi RPC transcript-only updates; that path already suppresses them. Keep Pi subprocess `message_end` updates immediate because they occur at turn boundaries after raw tool-result updates are removed.
- [ ] In Parallel mode, emit queued→running and terminal transitions immediately; schedule aggregate emissions caused only by child content/usage partials.
- [ ] In Chain/fanout mode, emit logical-step start/failure/terminal transitions immediately; schedule aggregate emissions caused by worker content/usage partials so four concurrent workers produce at most one aggregate update per interval.
- [ ] Leave strict coordinator writes for session files, ACP IDs, continuation delivery, fanout expansion, and terminal unit state outside the presentation coalescer.
- [ ] Add tests proving 100 rapid schedules produce one update containing the last value, terminal cancellation of pending work cannot be overtaken by a stale timer, cancellation emits nothing late, and structural status transitions remain immediate.
- [ ] Add integration assertions that the number of parent `onUpdate` calls is bounded for 1,000 synthetic Grok chunks and four concurrent fanout workers while the final visible output remains complete.

**Validation:**

- Run: `bun test packages/pi-agents/tests/update-coalescer.test.ts packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts`
- Expected: Update cadence is bounded, latest content wins, terminal ordering is deterministic, and no timer fires after cleanup.

### Task 7: Bound Interactive Agent Registry Transcript Retention

**Outcome:** Active endpoints preserve authoritative assistant text/usage needed for parent projection but bound every non-authoritative tool-result/thinking/tool-argument payload; reloadable oversized/LRU idle endpoints release their bounded transcript after settled subscribers consume it, while non-reloadable endpoints retain at most the configured presentation budget plus the latest authoritative assistant message.

**Files:**

- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Test: `packages/pi-agents/tests/interactive-agent.test.ts`
- Test: `packages/pi-agents/tests/interactive-view.test.ts`
- Test: `packages/pi-agents/tests/interactive-relay.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Test: `packages/pi-agents/tests/pi-rpc-integration.test.ts`

**Steps:**

- [ ] Add `INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES = 64 * 1024` and `INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES = 512 * 1024` to `constants.ts`. The per-item cap applies to thinking, tool arguments, tool results, user/custom payloads, and omission markers during active execution/hydration; authoritative assistant text is exempt because it becomes `finalOutput`. The total cap decides whether a reloadable inactive endpoint remains warm.
- [ ] Add a projection helper used by both finalized-message append and wholesale hydrate/restore:
  - clone before modification so the native session/event object remains raw and untouched;
  - preserve complete assistant text, usage, model, stop reason, and message count required by `pi-rpc-execution`;
  - bound assistant thinking and tool-call argument payloads per item;
  - bound user/custom/tool-result content and tool-result details, replacing omitted data with explicit byte-count/session-history markers;
  - freeze the projected message before publishing it in `finalizedMessagesView`.
- [ ] Preserve one projected array element per finalized native message so activation `baselineMessageCount`, slicing, and message revisions remain stable even when payloads are compacted.
- [ ] Add internal `finalizedMessageBytes: number[]` plus `finalizedMessagesBytes` to `InteractiveAgentEndpoint` and exclude both from public snapshots. Keep one byte entry per projected message so replacements preserve array position and accounting.
- [ ] Define exact UTF-8 JSON-array accounting as `2 + sum(finalizedMessageBytes) + max(0, messageCount - 1)` for brackets and commas. Initialize/recompute it on register, restore, hydrate, and wholesale replace; update it once per finalized append/replacement; never recalculate it for streaming deltas. Temporary message serialization occurs once per finalized message, not once per stream/update snapshot.
- [ ] Add `evictFinalizedTranscript(endpoint)` that replaces `messages`/`finalizedMessagesView` with the shared empty view, clears streaming/tool transient state, resets the byte counter, increments revisions, and sets `transcriptHydrated = false` without deleting status, usage, binding, run/unit, cwd/worktree, or session identity metadata.
- [ ] Extend `detach()` with an internal `evictTranscript` option. Remove the idle client and start tracked disposal before clearing the endpoint view; subsequent lazy hydration must await the existing session lease/dispose barrier before reading.
- [ ] Preserve terminal delivery ordering: synchronously publish the `activation_settled` snapshot containing complete assistant and bounded non-assistant messages, let subscribers such as `pi-rpc-execution` project that immutable array, then enqueue a later transition that detaches/evicts if the endpoint is idle and exceeds the total cap. Never mutate the array already handed to settled subscribers.
- [ ] Make idle-LRU transport eviction request transcript eviction as well, so detached endpoints do not retain a second in-memory transcript after their process is gone.
- [ ] For a reloadable Pi/Grok ACP session artifact, leave the endpoint unhydrated after eviction; `ensureTranscriptHydrated()` must reuse the existing session lease and Pi `SessionManager.open` or ACP hydrate-only `session/load` path, then apply the same per-message projection before publishing history.
- [ ] For an endpoint with no reloadable native identity, run a post-settle budget compaction instead of full eviction: replace oldest entries with small role-preserving omission markers, preserve the latest authoritative assistant message plus endpoint aggregate usage/status, keep array length stable, and set `transcriptHydrated = true`. The deterministic ceiling is `max(INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES, latestAssistantJsonBytes + markerArrayOverhead)`; state that omitted raw history cannot be reloaded.
- [ ] Do not total-evict `starting`/`running` endpoints or an unsettled activation. Per-message projection still applies to finalized payloads during the active turn.
- [ ] Add tests proving:
  - large active tool-result/thinking/tool-argument payloads are bounded without changing message count or authoritative assistant final text;
  - exact serialized transcript bytes, including brackets/commas, match the tracked counters;
  - the settled event contains complete assistant messages and usage required by `pi-rpc-execution`;
  - the endpoint becomes detached/unhydrated and message-empty after deferred oversized idle eviction;
  - Agent View/detail hydration restores the same bounded view on demand while the native session remains raw;
  - LRU detach evicts transcript as well as transport;
  - non-reloadable endpoints satisfy the explicit budget-or-latest-assistant ceiling and include the unrecoverable-history marker;
  - active endpoints are never total-evicted mid-turn;
  - Interactive View renders omission/unrecoverable-history markers after bounding and after lazy hydration;
  - synchronous relay/`activation_settled` consumers receive the pre-eviction immutable snapshot before the deferred detach transition.

**Validation:**

- Run: `bun test packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/interactive-view.test.ts packages/pi-agents/tests/interactive-relay.test.ts packages/pi-agents/tests/pi-rpc-execution.test.ts packages/pi-agents/tests/pi-rpc-integration.test.ts`
- Expected: Non-authoritative active payloads and idle total retention satisfy exact serialized-byte rules, terminal/relay projection precedes eviction, omission markers render, lazy rehydration remains correct, and no active endpoint loses final output or usage.

### Task 8: Add End-to-End Memory Regressions and Update Documentation

**Outcome:** Tests enforce the intended size/ownership properties and user documentation accurately explains what is retained in the parent session, durable run, and native child session.

**Files:**

- Create: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/tutorials.md`

**Steps:**

- [ ] Start `memory-regression.test.ts` with the required two-line ABOUTME header.
- [ ] Build a synthetic Pi event stream containing 100 turns, 100 assistant tool calls, and 100 tool results with 64 KiB bodies. Assert the terminal parent result preserves assistant text/tool-call presentation and final output while excluding every raw tool-result body.
- [ ] Build an eight-item Parallel/fanout fixture with repeated partials and large raw child tool results. Assert:
  - final serialized parent `details` is below 2 MiB;
  - each unit retains final output, status, usage, structured output, and session identity;
  - aggregate update count satisfies the coalescer bound;
  - a retained early update remains unchanged after all later worker updates.
- [ ] Build a durable single/fanout fixture and assert compact details plus unit results remain below the documented synthetic thresholds without changing frozen mapping or resume behavior.
- [ ] Build an Interactive Agent View fixture with four reloadable warm idle endpoints plus one oversized endpoint; assert active projection completes, the oversized endpoint is empty/unhydrated after settle, and total warm retained transcript bytes are at most `MAX_IDLE_TRANSPORTS * INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES`.
- [ ] Document in README Features and Durable Runs that parent/durable results store compact assistant presentation, not raw child tool-result bodies.
- [ ] Update README Privacy and Disk Growth to state that reloadable native child sessions may still contain sensitive raw tool results even though parent sessions and `run.json` no longer duplicate them; when no native identity exists, raw bodies are intentionally released and cannot be recovered.
- [ ] Update the output-display explanation to distinguish:
  - mutable/native runtime transcript;
  - compact parent/durable presentation;
  - per-message bounded Agent View history with lazy rehydration.
- [ ] Update reference documentation with `ResultPresentation`, total/per-item presentation caps, 64 KiB diagnostic caps, the 512 KiB retained-idle endpoint cap, omission-marker behavior, lazy rehydration, and legacy fallback.
- [ ] Clarify tutorials that Ctrl+O expands the complete retained assistant/tool-call presentation and final response; Agent View shows a bounded transcript, while raw child tool-result history remains only in native storage/protocol when a reloadable identity exists.
- [ ] Remove or revise statements claiming that all raw tool results are preserved directly in parent tool details while retaining the guarantee that model-visible truncation does not silently remove the stored final assistant output.

**Validation:**

- Run: `bun test packages/pi-agents/tests/memory-regression.test.ts packages/pi-agents/tests/result-snapshot.test.ts packages/pi-agents/tests/update-coalescer.test.ts`
- Expected: Synthetic large-result, fanout, size, update-count, and isolation assertions pass.
- Run: `rg -n "raw tool|tool result|presentation|transcript|rehydrat|512 KiB|64 KiB" packages/pi-agents/README.md packages/pi-agents/docs/{explanation,reference,tutorials}.md`
- Expected: Documentation consistently distinguishes parent presentation, bounded interactive retention, reloadable native history, and non-reloadable raw-history loss while stating the exact limits.

### Task 9: Run Full Validation and a Reduced-Heap Soak

**Outcome:** The complete package passes deterministic checks and a real Pi process can repeatedly run multi-turn/fanout agents under a reduced heap without monotonic parent-detail growth or terminal-state regressions.

**Files:**

- Review: all files changed under `packages/pi-agents`

**Steps:**

- [ ] Run focused tests after each task, then package typecheck, the full package suite, repository lint/format checks, package build, and whitespace validation.
- [ ] Build the package and start the real parent in the foreground while recording its exact PID: `sh -c 'echo $$ > /tmp/pi-agents-memory-soak.pid; exec env NODE_OPTIONS=--max-old-space-size=512 pi -e ./packages/pi-agents/dist/index.js'`.
- [ ] In the reduced-heap process, run at least ten agent invocations including:
  - one long Pi single agent that performs repeated read/grep/bash tool calls;
  - one eight-task Parallel invocation;
  - one Chain with a structured-output seed, an eight-item fanout, and a final collecting step;
  - one interrupted durable run followed by resume.
- [ ] If Grok ACP credentials/runtime are available, add one Grok ACP invocation with streaming text/tool updates. Treat this as runtime-specific release coverage; deterministic Grok chunk/coalescer tests remain the required gate when credentials are unavailable.
- [ ] In a second terminal, run `parent_pid=$(cat /tmp/pi-agents-memory-soak.pid)` and record RSS with `ps -o rss= -p "$parent_pid"`, final parent-session file size, and affected `run.json` sizes before the first invocation and after each invocation. Confirm growth tracks compact final outputs/presentation rather than raw child tool-result bytes and the process remains below the reduced heap limit; remove `/tmp/pi-agents-memory-soak.pid` after the process exits.
- [ ] Toggle Ctrl+O during running and terminal Single, Parallel, and fanout views; confirm latest activity, full retained presentation, final output, omission marker, errors, worktree metadata, usage, and run identity render correctly.
- [ ] Resume one legacy full-message Version 1 fixture and one new compact run; confirm neither redispatches completed work and both preserve previous/named/structured outputs.
- [ ] Ask an independent reviewer to audit the final diff specifically for snapshot isolation, terminal flush ordering, structured-output preservation, resume compatibility, and unintended public-detail changes.
- [ ] Do not stage or commit unless explicitly requested.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript passes.
- Run: `mise run test --package packages/pi-agents`
- Expected: The complete package suite passes with zero failures.
- Run: `hk check`
- Expected: ESLint and Prettier pass repository-wide.
- Run: `mise run build --package packages/pi-agents`
- Expected: The package bundles successfully.
- Run: `git diff --check`
- Expected: No whitespace errors.
- Manual reduced-heap soak expected result: ten mixed invocations, fanout, interruption, and resume complete without V8 OOM; parent/durable serialized growth stays within the compact representation documented by the synthetic tests.

## Final Validation

- Run: `bun test packages/pi-agents/tests/result-snapshot.test.ts packages/pi-agents/tests/update-coalescer.test.ts packages/pi-agents/tests/memory-regression.test.ts packages/pi-agents/tests/output.test.ts packages/pi-agents/tests/render.test.ts packages/pi-agents/tests/execution.test.ts packages/pi-agents/tests/pi-rpc-execution.test.ts packages/pi-agents/tests/pi-rpc-integration.test.ts packages/pi-agents/tests/interactive-agent.test.ts packages/pi-agents/tests/interactive-view.test.ts packages/pi-agents/tests/interactive-relay.test.ts packages/pi-agents/tests/tool.test.ts packages/pi-agents/tests/chain.test.ts packages/pi-agents/tests/run-coordinator.test.ts packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/resume.test.ts packages/pi-agents/tests/completion-check.test.ts`
- Expected: Compact/legacy rendering, runtime projection, mutation isolation, fanout copy-on-write, update coalescing, durability, resume, and size regressions all pass.
- Run: `mise run typecheck --package packages/pi-agents && mise run test --package packages/pi-agents && hk check && mise run build --package packages/pi-agents && git diff --check`
- Expected: Every command succeeds with no known regression.
- Inspect: compare serialized synthetic raw results, compact parent details, and compact durable records produced by the memory regression tests.
- Expected: Raw child tool-result bodies do not appear in parent/durable snapshots; final output, structured output, session identity, and visible transcript remain present; documented byte limits are enforced.

## Rollout Notes

- New code prevents future parent/durable duplication but cannot remove large tool-result details already loaded in the current parent `SessionManager.fileEntries`. After deploying the change, start a new parent Pi session/process to realize the full heap benefit.
- Existing parent session JSONL files remain large on disk until manually removed according to the user's retention policy. Pi compaction does not rewrite or delete those historical entries.
- Existing inactive Version 1 durable runs remain unchanged and may still be large. A run is compacted only when actively resumed and written again; bulk migration is intentionally deferred.
- No `RUN_RECORD_VERSION` bump or user configuration migration is required.
- The change reduces duplicate sensitive data, but native child Pi sessions and Grok ACP storage may still contain raw prompts and tool results and must remain protected.
- The visible renderer should remain unchanged except for a clear omission marker when the new presentation cap drops old transcript items.
- The implementation should land in reviewable commits aligned with Tasks 1–8; the final validation task should not mix unrelated cleanup into those commits.

## Risks and Mitigations

- **Removing raw `toolResult` messages may break undocumented consumers of `details.results[*].messages`.** — Add the explicit `presentation` field, retain legacy `messages` support, document the new contract, and keep raw history addressable only when a reloadable session identity exists.
- **Clearing `messages` can make final output disappear from workflow logic.** — Derive and store `finalOutput` before compaction, route terminal callers through `getResultFinalOutput()`, and cover completion check, Chain previous/named output, structured extraction, and fanout resume.
- **Sequential structured-output validation currently runs after `runStepWithContext` has already called `endUnit`.** — Pass sequential validation through `postprocessTerminal` before compaction/durability and add a structured seed → fanout → interruption/resume regression.
- **The Grok ACP parser mutates message text/tool arguments in place.** — Never expose its live result; clone display items once in `snapshotSingleResult()` before any callback crosses the runtime boundary.
- **Pi RPC needs tool-result/user messages for baseline and usage bookkeeping even if parent presentation does not.** — Compute post-baseline usage and terminal metadata from the complete endpoint snapshot before filtering the parent live result to assistant messages.
- **Copy-on-write can reintroduce aliasing if aggregate code later mutates a prior snapshot.** — Deep-freeze shared presentation/structured payloads once, replace changed slots rather than editing them, create new arrays/top-level shells per emission, document snapshot payloads as read-only, and retain prior updates in regression tests to detect mutation.
- **Coalescing can allow a stale timer to overwrite terminal output.** — Require terminal paths to cancel pending running content and emit one latest terminal snapshot, unref timers, and test abort/error/final ordering with a fake clock.
- **Presentation truncation can hide early tool-call context or an oversized latest item can bypass the total cap.** — Apply deterministic per-item and whole-presentation caps, de-duplicate latest text from final output, preserve bounded latest activity, render an exact omitted-item marker, and reload native child history when identity exists.
- **Diagnostic truncation can hide the relevant part of an error.** — Keep stderr tails, error-message prefixes, and stack prefixes with explicit omitted-byte markers; preserve formal error code, stop reason, and session/worktree identity.
- **Legacy normalization could mutate an inactive record merely by inspecting it.** — Normalize only after a run is claimed for resume and before active registration; listing/status remain read-only.
- **Structured outputs can still be large.** — Preserve them because Chain/fanout correctness depends on exact values; treat artifact externalization as a separate design rather than silently truncating them.
- **Interactive endpoints can retain a second raw transcript even after compact parent projection.** — Track finalized transcript bytes, publish settled messages before deferred eviction, detach oversized/LRU idle transports, and test lazy rehydration plus non-reloadable bounded fallback.
- **Historical parent entries continue occupying heap after extension reload.** — Document that a new parent session/process is required after rollout; do not claim compaction or reload frees those objects.
- **A wall-clock heap assertion would be flaky in CI.** — Enforce deterministic serialized-size, update-count, and aliasing properties in tests, then use the reduced-heap real-process soak as release validation rather than a unit-test gate.
