# Agent RPC Overflow and Result Artifact Spill Implementation Plan

**Goal:** Prevent oversized replayable Pi RPC events from failing subagent runs and externalize large authoritative result payloads into validated run-local artifacts without changing Chain, fanout, resume, or extension semantics.

**Inputs:** The failed durable run `run-40cc88b2-52c6-4c7a-a1f4-ee9547a00f1d`, the request to confirm that `agent_end.messages` is unused before stripping it, the requirement to keep all changes inside `pi-toolset`, Pi 0.80.7 RPC/session behavior, and `packages/pi-agents/docs/plans/2026-07-16-subagent-memory-optimization-plan.md`.

**Assumptions:**

- Pi upstream cannot be modified. The transport must therefore project the current canonical Pi `JSON.stringify()` shape locally and fail closed if a future Pi version changes the oversized shape.
- The compact result snapshot work in `2026-07-16-subagent-memory-optimization-plan.md` lands before the result-artifact phase. The immediate replayable-event transport fix is independent and can ship first.
- Native Pi `sessionFile` remains the authoritative full transcript. No second transcript artifact is created for projected RPC events or `get_messages`.
- Fixed Version 1 limits are used initially: 2 MiB for ordinary RPC records, 64 MiB for a structurally valid projectable replayable event, 256 KiB per inline authoritative result payload, and 64 MiB per run artifact.
- Large final output is handed to the parent or next agent as a bounded artifact descriptor. Large structured output is loaded only by trusted workflow code when schema, JSON Pointer, fanout, or resume semantics require the actual value.

**Architecture:** Split the work into three ordered boundaries. First, the Pi RPC reader performs a fully validating streaming projection for canonical oversized events whose payload is replayable from the native session (`message_start`, `message_update`, `message_end`, `turn_end`, tool execution start/update/end, and `agent_end`); all unrelated records retain the existing 2 MiB fail-closed limit. The interactive registry marks projected transcript events and rehydrates the persisted child branch before publishing `agent_settled`. Second, a run-local content-addressed artifact store publishes immutable text/JSON payloads before durable references are written. Third, terminal compact snapshots externalize oversized `finalOutput`, `structuredOutput`, Chain outputs, and frozen fanout items while workflow accessors preserve inline behavior for small values and resolve references only when required.

**Tech Stack:** TypeScript, Node streams and filesystem APIs, incremental JSON tokenization, SHA-256, Pi RPC JSONL, Pi `SessionManager`, Bun tests, Mise, ESLint, Prettier, and HK.

---

## Audit Verdict

`agent_end.messages` has no consumer in `packages/pi-agents` and can be removed at the Pi RPC transport boundary:

- `packages/pi-agents/src/interactive-agent.ts` handles RPC `agent_end` only as a metadata tick: it updates `lastUsedAt`, keeps the activation running, and waits for `agent_settled`. It does not inspect `messages` or `willRetry`.
- `packages/pi-agents/src/pi-rpc-execution.ts` consumes projected registry updates, not raw `agent_end` payloads.
- `packages/pi-agents/src/execution.ts` handles only `message_end` and `tool_result_end` in the non-RPC subprocess path.
- `packages/pi-agents/src/index.ts` subscribes to the host Pi Extension API `agent_end` only to stop spinners. That host event is distinct from the child RPC stdout record and is unaffected by transport projection.
- Existing tests include `messages: []` in RPC fixtures but never assert on the field. `packages/pi-agents/tests/pi-rpc-transport.test.ts` already accepts an `agent_end` record with no `messages` field.

Pi internal extension and retry semantics remain intact because Pi consumes the original `agent_end.messages` before serializing the session event to RPC stdout. The local projection occurs only after those upstream decisions have happened. Preserve `willRetry` for protocol compatibility even though `pi-agents` currently does not branch on it.

The failed run provides the baseline regression:

- 143 run messages: 1 user, 50 assistant, and 92 tool-result messages.
- Largest persisted session line: 106,832 bytes, below the 2 MiB ordinary-record limit.
- Reconstructed final `agent_end` record: 2,320,362 bytes, 223,210 bytes above the limit.
- The model first persisted a small context-window error message, then Pi emitted the oversized aggregate `agent_end`, which replaced the useful model error with `RPC stdout record exceeded 2 MiB`.

`agent_end` projection alone is insufficient for generic large `finalOutput`: Pi emits cumulative `message_update`, full `message_end`, and `turn_end` records before terminal result externalization. These payloads are consumed for live UI, but their authoritative finalized forms are persisted in `sessionFile` before `agent_settled`. Oversized canonical instances may therefore be replaced by omission metadata only when the registry performs a verified settle-time session rehydrate before exposing the terminal snapshot.

## Scope Decisions

### Included

- Local, structurally validating projection of oversized canonical replayable Pi events.
- Replacement of the `agent_end.messages` payload with an empty array for every record delivered to `pi-agents` subscribers, including records below 2 MiB.
- Settle-time rehydration and usage/status recomputation whenever an oversized transcript/tool event was projected.
- Explicit prevention of `get_messages` in `PiRpcTransport`; full history continues through the existing, lease-protected `sessionFile` hydration path.
- Versioned, content-addressed, run-local artifacts for large terminal result and interactive-continuation payloads.
- Exact-one-of inline/reference schemas for result, continuation, Chain output, and frozen fanout data.
- Artifact-first durable commits, reference validation, lazy structured-value resolution, capability-checked file handoff, rendering, resume behavior, tests, and documentation.

### Excluded

- Any modification or patch to `pi-mono` / `@earendil-works/pi-coding-agent`.
- Raising the ordinary 2 MiB RPC record limit globally.
- A local proxy subprocess between `pi-agents` and Pi.
- Duplicating full transcripts into a second artifact format.
- Automatic run/artifact retention or garbage collection. Version 1 continues to retain the whole run directory until manual deletion.
- Externalization of arbitrary binary/image payloads.

### `get_messages` Decision

Do not add artifact spill for `get_messages` in this repository:

- `PiRpcTransport.getMessages()` has no production caller.
- Pi Agent View and resume already hydrate Pi history from `SessionManager.open(sessionFile)` under the session lease.
- A second `get_messages` artifact would duplicate prompts and tool results, increase privacy/disk exposure, and introduce a second transcript authority.
- Because upstream cannot be changed, an oversized `get_messages` response would have to be intercepted with another protocol-specific streaming path. There is no current product requirement that justifies that complexity.

Remove the unused convenience method and reject a generic `request({ type: "get_messages" })` with a structured `get_messages_disabled` transport error directing callers to `sessionFile` hydration. Reconsider a separate `getMessagesArtifact()` contract only when a real non-session consumer exists.

## Data Contracts

### Compact Replayable RPC Events

Projected records delivered to listeners use these bounded shapes:

```ts
interface CompactPiRpcAgentEnd {
  type: 'agent_end';
  messages: [];
  messagesOmitted: true;
  willRetry: boolean;
}

type CompactPiRpcMessageOmitted = {
  type: 'message_start' | 'message_update' | 'message_end';
  payloadOmitted: true;
  role: string;
};

type CompactPiRpcToolOmitted = {
  type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';
  payloadOmitted: true;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
};

type CompactPiRpcTurnEnd = {
  type: 'turn_end';
  payloadOmitted: true;
};
```

Only current canonical producer prefixes are eligible for the extended streaming budget, including:

```json
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"message_start","message":{"role":"assistant",...}}
{"type":"message_update","assistantMessageEvent":{...},"message":{"role":"assistant",...}}
{"type":"message_end","message":{"role":"assistant",...}}
{"type":"turn_end","message":{...},"toolResults":[...]}
{"type":"tool_execution_start","toolCallId":"...","toolName":"...","args":{...}}
{"type":"tool_execution_update","toolCallId":"...","toolName":"...","args":{...},"partialResult":{...}}
{"type":"tool_execution_end","toolCallId":"...","toolName":"...","result":{...},"isError":false}
```

A future key order, duplicate top-level key, or non-canonical oversized shape does not receive an exception and fails at the ordinary 2 MiB boundary. Once an exact eligible prefix has been recognized, that record receives the separate 64 MiB projectable budget; malformed JSON or an invalid required shell field discovered later fails as `malformed_json`. Valid sub-2-MiB records use normal `JSON.parse`; only `agent_end.messages` is always cleared because it is unconsumed. Other small event payloads remain available for normal live UI.

### Run Artifact Reference

```ts
export type RunArtifactPayload =
  | 'final-output'
  | 'structured-output'
  | 'chain-output-text'
  | 'chain-output-structured'
  | 'fanout-items'
  | 'fanout-item'
  | 'interactive-continuation';

export interface RunArtifactRefV1 {
  kind: 'run-artifact';
  version: 1;
  runId: string;
  payload: RunArtifactPayload;
  relativePath: string;
  sha256: string;
  bytes: number;
  mediaType: 'text/plain; charset=utf-8' | 'application/json';
}
```

`relativePath` must equal the digest-derived form:

```text
artifacts/sha256/<first-two-hex>/<64-hex-sha256>.txt
artifacts/sha256/<first-two-hex>/<64-hex-sha256>.json
```

The run ID and media type are part of validation, not path input. Callers never choose a relative path.

### Inline-or-Reference Rules

- `SingleResult`: at most one of `finalOutput` / `finalOutputRef`, and at most one of `structuredOutput` / `structuredOutputRef`.
- `ChainOutputEntry`: exactly one of `text` / `textRef`; zero or one structured value, represented by at most one of `structured` / `structuredRef`.
- `WorkflowFanoutState`: exactly one of `items` / `itemsRef`.
- `InteractiveContinuationDetails`: exactly one of `output` / `outputRef` when the continuation produced final text.
- Legacy records containing inline fields remain valid and readable.
- New records with both an inline value and its reference, or neither where a value is required, fail durable validation as `corrupt_run`.

### Child Artifact Reader

When Chain handoff text references a run artifact, Pi children receive one dedicated tool rather than relying on the general `read` tool:

```ts
pi_agents_read_artifact({
  runId: 'run-...',
  sha256: '<64 hex>',
  offsetBytes: 0,
  maxBytes: 48 * 1024,
});
```

The tool receives the allowed artifact root through a private child environment variable, derives the content-addressed path from `runId`/digest, rejects caller paths, verifies the regular file and digest, returns a UTF-8-safe bounded chunk plus `nextOffsetBytes`, and supports long single-line text/JSON. It is loaded only for Pi-runtime steps whose rendered task contains an artifact handoff. Grok ACP cannot load this extension in Version 1 and fails before dispatch with `artifact_handoff_unsupported`.

## File Map

### Immediate RPC Fix

- Create: `packages/pi-agents/src/pi-rpc-record-projector.ts` — Incremental JSON tokenizer and canonical replayable-event omission state machine.
- Modify: `packages/pi-agents/src/pi-rpc-transport.ts` — Integrate record projection, retain ordinary limits, compact replayable events, and disable `get_messages`.
- Modify: `packages/pi-agents/src/interactive-agent.ts` — Track omitted RPC transcript payloads and rehydrate the owned Pi session before terminal publication.
- Create: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts` — Chunk-boundary, malformed JSON, nesting, UTF-8, limit, and projection coverage.
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts` — Realistic oversized aggregate/final-message regressions and disabled `get_messages` behavior.
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts` — Use compact `agent_end` fixtures and confirm settle/retry behavior is unchanged.
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts` — Confirm compact `agent_end` never settles an activation.
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts` — Confirm relay ordering is unchanged with omitted messages.

### Artifact Store and Durable Schema

- Create: `packages/pi-agents/src/artifact-store.ts` — Content-addressed atomic publication, digest/size verification, safe path resolution, and text/JSON reads.
- Modify: `packages/pi-agents/src/constants.ts` — Add inline, artifact, JSON-depth, prefix-probe, and projectable-record limits.
- Modify: `packages/pi-agents/src/run-types.ts` — Add `RunArtifactRefV1`, artifact payload kinds, and inline/reference fanout state.
- Modify: `packages/pi-agents/src/types.ts` — Add result and Chain-output artifact references while retaining legacy inline fields.
- Modify: `packages/pi-agents/src/run-store.ts` — Expose run-scoped artifact write/read/resolve APIs, add strict non-swallowing writes, and validate every persisted reference.
- Modify: `packages/pi-agents/src/run-persistence.ts` — Keep coordinator registration and durable claim ownership consistent on finalization success/failure.
- Modify: `packages/pi-agents/src/run-coordinator.ts` — Await artifact-backed terminal snapshots and strict durable writes; support inline/reference fanout state throughout merge, mirror, equality, and expansion paths.
- Modify: `packages/pi-agents/src/resume.ts` — Resolve and validate artifact-backed fanout mappings during both pre-claim and post-claim inspection.
- Create: `packages/pi-agents/tests/artifact-store.test.ts` — Atomicity, permissions, deduplication, corruption, symlink, path traversal, and crash-window tests.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — Version 1 additive reference validation and legacy compatibility.
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts` — Artifact-first commit ordering and no dangling durable references.

### Result and Workflow Integration

- Create: `packages/pi-agents/src/result-payload.ts` — Byte accounting, terminal externalization, bounded handoff descriptors, and verified value resolvers.
- Modify after prerequisite creation: `packages/pi-agents/src/result-snapshot.ts` — Externalize authoritative payloads only from terminal compact snapshots.
- Modify: `packages/pi-agents/src/output.ts` — Resolve inline final text or format an artifact handoff without loading full text into parent context.
- Modify: `packages/pi-agents/src/tool.ts` — Await terminal externalization/durability and return artifact-aware parent content.
- Modify: `packages/pi-agents/src/execution.ts` — Keep low-level Pi/Grok terminal updates provisional so oversized terminal payloads cannot escape before externalization.
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts` — Keep RPC terminal updates provisional and defer authoritative terminal delivery to the artifact-aware boundary.
- Modify: `packages/pi-agents/src/chain.ts` — Preserve handoff, structured validation, fanout expansion, collection, and resume with inline/reference values.
- Create: `packages/pi-agents/src/artifact-reader-extension.ts` — Child-only `pi_agents_read_artifact` tool that derives paths from run ID/digest and returns bounded byte chunks.
- Modify: `packages/pi-agents/src/security.ts` — Add the dedicated artifact-reader tool to effective child tool arguments only when an artifact handoff is present.
- Modify: `packages/pi-agents/src/invocation.ts` — Explicitly load the child-only extension and pass its run-scoped environment when required.
- Modify: `packages/pi-agents/src/interactive-relay.ts` — Externalize oversized continuation output before injecting a bounded host custom message.
- Modify: `packages/pi-agents/src/index.ts` — Inject `RunStore` into the async continuation relay and track relay promises.
- Modify: `packages/pi-agents/src/render.ts` — Render artifact metadata and paths without automatically loading large content.
- Modify: `packages/pi-agents/package.json` — Build and publish the child-only artifact-reader extension as a separate `dist` entry.
- Modify: `packages/pi-agents/src/completion-check.ts` — Assert completion checks run only against private inline runtime output before externalization.
- Create: `packages/pi-agents/tests/result-payload.test.ts` — Threshold, exact-one-of, handoff descriptor, resolver, and corruption behavior.
- Modify: `packages/pi-agents/tests/chain.test.ts` — Large previous output, named output, fanout, collection, and resume cases.
- Create: `packages/pi-agents/tests/artifact-reader-extension.test.ts` — Digest-derived path guard, byte chunking, UTF-8 boundary, corruption, and permission tests.
- Modify: `packages/pi-agents/tests/security.test.ts` — Dedicated artifact-reader allowlist injection and non-handoff isolation.
- Modify: `packages/pi-agents/tests/invocation.test.ts` — Child extension/env arguments appear only for Pi artifact handoffs.
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts` — Large continuation output uses an artifact-backed bounded custom message.
- Modify after prerequisite creation: `packages/pi-agents/tests/result-snapshot.test.ts` — Terminal externalization while preserving presentation and identity.
- Modify after prerequisite creation: `packages/pi-agents/tests/memory-regression.test.ts` — Serialized parent/durable size with artifact-backed authoritative output.
- Modify: `packages/pi-agents/tests/render.test.ts` — Collapsed/expanded artifact rendering.

### Documentation

- Modify: `packages/pi-agents/README.md` — Add `artifacts/` layout, handoff behavior, privacy, disk growth, and manual deletion.
- Modify: `packages/pi-agents/docs/reference.md` — Document RPC projection, limits, artifact schema, errors, and inline/reference contracts.
- Modify: `packages/pi-agents/docs/explanation.md` — Explain control-plane projection versus session/result data planes.
- Modify: `packages/pi-agents/docs/how-to.md` — Show how parent/next agents inspect spilled output and diagnose missing/corrupt artifacts.

## Tasks

### Task 1: Lock the Overflow Regression and Consumption Contract

**Outcome:** Tests encode the observed failure shape and prove that `pi-agents` requires only the `agent_end` lifecycle signal, not its message array.

**Files:**

- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Generate a synthetic `agent_end` with 143 messages and a serialized size between 2.2 MiB and 2.3 MiB; do not commit a multi-megabyte fixture.
- [ ] Generate a second fake-child sequence with cumulative `message_update`, full `message_end`, `turn_end`, `agent_end`, and `agent_settled` around a 4 MiB assistant final message persisted to a temporary native session file.
- [ ] Assert the current transport fails with `stdout_overflow` before the production fix, matching the observed run and proving that `agent_end`-only projection would not support large final output.
- [ ] Replace lifecycle fixtures with the compact shapes and retain `willRetry: true` / `false` variants.
- [ ] Assert compact `agent_end` updates metadata only, never settles, never clears queues/tools/streaming, and never triggers continuation relay; `agent_settled` remains the sole terminal signal.
- [ ] Assert projected transcript/tool events require settle-time hydration and that no terminal snapshot is published before hydration succeeds.
- [ ] Add a source audit assertion with `rg` in the validation notes rather than a brittle code-scanning unit test.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts)`
- Expected before Task 2: only the new oversized transport regressions fail with `stdout_overflow`; lifecycle tests accept bounded omission events.

### Task 2: Implement a Fail-Closed Streaming Replayable-Event Projector

**Outcome:** Canonical replayable Pi events may exceed 2 MiB without retaining their full payloads, and the registry reconstructs authoritative transcript state from `sessionFile` before terminal publication.

**Files:**

- Create: `packages/pi-agents/src/pi-rpc-record-projector.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/src/interactive-agent.ts`
- Create: `packages/pi-agents/tests/pi-rpc-record-projector.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-execution.test.ts`

**Steps:**

- [ ] Add `MAX_STDOUT_RECORD_BYTES = 2 * 1024 * 1024`, `MAX_PROJECTABLE_RPC_RECORD_BYTES = 64 * 1024 * 1024`, `RPC_PREFIX_PROBE_BYTES = 512`, and `RPC_JSON_MAX_DEPTH = 256` to shared constants; remove the transport-local duplicate.
- [ ] Give the projector injectable limit/depth options for tests while wiring the fixed constants in production.
- [ ] Implement a streaming tokenizer that validates complete decoded JSON grammar: object/array key-value state, commas/colons, strings, escapes, four-hex-digit `\u` escapes, numbers, `true`/`false`/`null`, maximum nesting, LF framing, optional trailing CR, and EOF.
- [ ] Recognize only the exact current Pi prefixes shown in the data contract for `agent_end`, `message_start`, `message_update` (notably `assistantMessageEvent` before `message`), `message_end`, `turn_end`, and tool execution start/update/end before the ordinary cap. If recognition is not complete within `RPC_PREFIX_PROBE_BYTES`, keep the record on the ordinary path.
- [ ] For canonical `agent_end`, discard `messages`, preserve/validate `willRetry`, and emit the compact contract only after the entire record validates.
- [ ] For message start/update/end, extract and validate `message.role` before discarding the remaining accumulated message payload; emit the compact message shell so assistant turn accounting can still run at `message_end`.
- [ ] For tool start/update/end, preserve/validate `toolCallId`, `toolName`, and terminal `isError` when present, then discard args/result payloads. For `turn_end`, retain only the type/omission flag.
- [ ] Track total bytes seen even when discarded; fail with `stdout_overflow` at `MAX_PROJECTABLE_RPC_RECORD_BYTES`.
- [ ] On malformed projected input, fail with `malformed_json`; never turn malformed input into a synthetic valid event.
- [ ] Preserve stdout order when a chunk contains the end of a projected record plus subsequent records.
- [ ] Keep the existing `StringDecoder` split-code-point behavior and LF-only framing; define grammar validation over its decoded character stream.
- [ ] In `handleLine()`, defensively compact valid sub-2-MiB `agent_end` records after `JSON.parse`, regardless of key order. Preserve other small event payloads.
- [ ] Do not raise limits for user/queue events, compaction/retry events, extension UI, responses, or unknown record types.
- [ ] Add an endpoint flag such as `rpcTranscriptPayloadOmitted`. Compact message/tool events set it, clear unsafe streaming/tool partial state, and publish at most bounded omission metadata while the activation remains running.
- [ ] When a compact assistant `message_end` arrives, increment the activation's assistant-turn counter and apply the existing `maxTurns` abort policy immediately from the preserved role; do not wait until settle-time hydration to enforce the turn limit.
- [ ] Before reducing `agent_settled`, if the flag is set, directly open the endpoint's already-owned/validated Pi `sessionFile` inside the same transition (do not wait on its own session lease), load the active branch, replace finalized messages, recompute post-baseline usage/model/stop reason/turn count without double-counting the compact event, clear the flag, and only then publish `activation_settled`.
- [ ] If settle-time hydration is missing, malformed, path-mismatched, or does not contain the expected finalized branch, fail the activation with `hydrate_error`; never publish a successful terminal snapshot from omission metadata alone.
- [ ] Add tests at every byte chunk boundary for representative records, plus the exact `message_update` key order, non-streaming oversized `message_start`, oversized tool start args, compact assistant `message_end` with `maxTurns: 1`, escaped quotes/backslashes, `\u2028`/`\u2029`, multibyte UTF-8, nested messages, empty arrays, CRLF, unterminated EOF, duplicate/out-of-order keys, trailing commas, invalid literals/numbers, depth overflow, multiple records per chunk, and non-canonical oversized fallback. Exercise the hard-cap branch with an injected small cap; keep realistic 2.2 MiB aggregate and 4 MiB final-output integrations.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/pi-rpc-record-projector.test.ts tests/pi-rpc-transport.test.ts tests/interactive-agent.test.ts tests/pi-rpc-execution.test.ts)`
- Expected: oversized eligible events become bounded omission events, the persisted 4 MiB final message is restored before settle, later records remain readable, and every oversized non-eligible record still fails at 2 MiB.

### Task 3: Remove the Unused `get_messages` Hazard

**Outcome:** `pi-agents` cannot accidentally request an unbounded single-line transcript response; native session hydration remains the only Pi history path.

**Files:**

- Modify: `packages/pi-agents/src/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/tests/pi-rpc-transport.test.ts`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`

**Steps:**

- [ ] Remove `PiRpcTransport.getMessages()` and the now-unused `AgentMessage` transport import.
- [ ] Reject `request({ type: 'get_messages' })` before writing stdin with `PiRpcTransportError('get_messages_disabled', 'get_messages is disabled; hydrate the validated sessionFile instead')`.
- [ ] Replace tests that used `get_messages` only as a second pending request with another bounded command such as `get_state`.
- [ ] Add a test asserting the command writes no stdin bytes and creates no pending request.
- [ ] Retain `interactive-agent.ts` hydration through `SessionManager.open(sessionFile)` and its existing session lease/path validation unchanged.
- [ ] Document that Pi RPC upstream still exposes `get_messages`, but this integration intentionally does not use it because the response is unbounded and redundant with the native session artifact.

**Validation:**

- Run: `rg -n "getMessages\(|get_messages" packages/pi-agents/src packages/pi-agents/tests`
- Expected: only the explicit rejection guard, test, and documentation references remain; no production request path exists.

### Task 4: Add the Run-Local Content-Addressed Artifact Store

**Outcome:** Large immutable text/JSON payloads can be published and read safely, with artifact durability preceding any reference.

**Files:**

- Create: `packages/pi-agents/src/artifact-store.ts`
- Modify: `packages/pi-agents/src/constants.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Create: `packages/pi-agents/tests/artifact-store.test.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Add `RESULT_INLINE_PAYLOAD_MAX_BYTES = 256 * 1024` and `RUN_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024`.
- [ ] Add the Version 1 reference and payload-kind types exactly as defined above.
- [ ] Extend `RunStore` with `writeTextArtifact`, `writeJsonArtifact`, `readTextArtifact`, `readJsonArtifact`, and `resolveArtifactPath`; every method takes `runId` plus a validated reference or payload kind, never a caller-chosen path.
- [ ] Serialize text as UTF-8 and structured values as two-space-indented JSON so the `read` tool can inspect large JSON artifacts by line range. Reject non-JSON values and payloads above the hard cap with `artifact_too_large`.
- [ ] Create/verify `artifacts/`, `artifacts/sha256/`, digest-prefix directories, and staging files with private permissions (`0700` directories, `0600` files where supported). On every write attempt—not only after `mkdir` reports creation—strictly sync each parent in order (`run dir` for `artifacts`, `artifacts` for `sha256`, and `sha256` for the digest-prefix directory) before publishing content. This makes retries after a prior parent-sync failure idempotently re-establish directory reachability.
- [ ] Hash bytes before publishing; derive the destination solely from SHA-256 and media type.
- [ ] Write a same-filesystem staging file, strictly `fsync` it, atomically rename it to the content-addressed destination, and strictly `fsync` the digest-prefix directory. Propagate file-sync errors everywhere. On non-Windows platforms, propagate every directory-sync error; on Windows, skip directory `fsync` explicitly while retaining strict file flushes and atomic rename semantics. On Windows `EEXIST`, verify the existing regular file's exact size and digest before discarding staging.
- [ ] Return the reference only after publication completes. A crash may leave an unreferenced staging/content file, but never a durable reference to an unpublished file.
- [ ] Resolve references with strict run ID, regex, extension/media-type, containment, `lstat`/`realpath`, regular-file, byte-count, SHA-256, and no-symlink checks. Use `O_NOFOLLOW` where available and retain the realpath guard on every platform.
- [ ] Add `RunStore.updateRunStrict()` / strict write plumbing that uses strict file and directory synchronization rather than the existing swallow-all directory-sync helper. Keep best-effort/coalesced writes separate and never use them for a terminal artifact reference.
- [ ] Add run-record validation for every reference in unit results, presentation results, Chain outputs, and fanout state.
- [ ] Keep legacy inline-only Version 1 records valid.
- [ ] Do not clean unreferenced artifacts while another process may hold a run claim; Version 1 leaves them until the whole inactive run directory is manually deleted.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/run-store.test.ts)`
- Expected: content deduplicates by digest, directory-chain and file sync ordering runs on first write and retry, injected file/directory sync failures propagate, all published files verify, tampered/missing/symlinked/path-escaping refs fail closed, and a simulated pre-reference crash leaves only an unreferenced file.

### Task 5: Add Artifact-Aware Result and Snapshot Contracts

**Outcome:** Terminal compact snapshots preserve authoritative output by inline value or immutable reference without conflating the value with model-visible handoff text.

**Prerequisite:** Complete the compact snapshot and presentation tasks in `2026-07-16-subagent-memory-optimization-plan.md` through terminal/durable snapshot integration.

**Files:**

- Create: `packages/pi-agents/src/result-payload.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/result-snapshot.ts`
- Modify: `packages/pi-agents/src/output.ts`
- Modify: `packages/pi-agents/src/completion-check.ts`
- Create: `packages/pi-agents/tests/result-payload.test.ts`
- Modify: `packages/pi-agents/tests/result-snapshot.test.ts`

**Steps:**

- [ ] Add `finalOutputRef` and `structuredOutputRef` to `SingleResult`; never place a descriptor string in `finalOutput` and never place a ref object in `structuredOutput`.
- [ ] Add exact-one-of validators and pure byte-measurement helpers using the exact UTF-8 bytes that will be persisted.
- [ ] Implement `externalizeTerminalResult(snapshot, runStore)` as an async terminal-only operation: values at or below 256 KiB stay inline; larger values are written first and replaced by refs on the snapshot.
- [ ] Add explicit snapshot phases. Running/provisional snapshots must omit `finalOutput`, `structuredOutput`, and their refs and carry only bounded presentation/usage/status; the private runtime result alone retains full assistant text until the terminal barrier.
- [ ] Run completion checks, final-output extraction, JSON extraction/schema validation, and worktree metadata stamping against the private full runtime result before externalization.
- [ ] Implement `formatArtifactHandoff(ref, absolutePath)` with a bounded message containing payload kind, byte count, absolute read path, and SHA-256. Keep it below 2 KiB.
- [ ] Implement result-aware helpers for parent content and rendering that prefer inline output, otherwise format the reference without reading the full artifact.
- [ ] Implement verified async structured-value resolution for internal workflow use only.
- [ ] If artifact publication fails, return a terminal `artifact_write_error` result with the native session identity and error details but without copying the oversized value into parent/durable details.
- [ ] Preserve deep-freeze/idempotence rules from the compact snapshot plan; repeated snapshot/externalization calls reuse the same reference and never rewrite content.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/result-payload.test.ts tests/result-snapshot.test.ts tests/completion-check.test.ts)`
- Expected: small terminal values remain behavior-compatible, every provisional update stays bounded and omits authoritative payload fields, large terminal values become verified refs, handoff text stays bounded, and completion/schema checks see the original full value.

### Task 6: Make Artifact Publication a Durable Terminal Barrier

**Outcome:** `run.json`, terminal events, parent updates, and workflow callers never observe a reference before its artifact exists and verifies.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/run-persistence.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/execution.ts`
- Modify: `packages/pi-agents/src/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/interactive-relay.ts`
- Modify: `packages/pi-agents/src/index.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`

**Steps:**

- [ ] Change terminal `postprocessTerminal` / `endUnit` plumbing to support awaited async work; update every caller rather than fire-and-forget promises.
- [ ] Keep the private runtime result until completion/schema/worktree processing finishes, then create a compact snapshot and await `externalizeTerminalResult`.
- [ ] Make `RunCoordinator.finishUnit()` async. Cancel pending coalesced timers, build the terminal mutation on a private clone, and use a new strict coordinator flush path that directly awaits `store.updateRunStrict()` and propagates failures; do not mutate the live record first and do not route terminal durability through the existing `updateRun()` / best-effort `writeRun()` / `persist()` paths that swallow errors.
- [ ] Only after the strict `run.json` update succeeds may the coordinator mirror terminal state into the live record, append/flush `unit_terminal`, and return. On strict-write failure, leave live state non-terminal, surface `durable_write_error`, and ensure a later coalesced flush cannot persist the rejected terminal clone.
- [ ] Add the same private-clone, error-propagating barrier to `RunCoordinator.finalizeRun()`. Chain collect outputs and their refs are created after worker `finishUnit()` calls, so final run status/details/outputs must be durably written through `updateRunStrict()` before returning success; never use the current swallowing `writeRun()` path. Remove coordinator-owned unregistration from `finalizeRun()` so the claim owner can append `run_terminal` and then unregister/release in one ordered success path.
- [ ] Externalize Chain collect text/structured payloads before strict `finalizeRun()`, include their refs in the private final record, and convert any artifact/final-write failure into `artifact_write_error` / `durable_write_error` rather than returning a successful Chain result.
- [ ] Replace unconditional claim release in both `run-persistence.ts` and the resume `StartedRun.finalize` wrapper. On success: strict finalize, append `run_terminal`, unregister, then release the claim. On failure: cancel pending timers, discard the uncommitted private terminal clone, unregister the live coordinator record, mark the claim abandoned with `store.abandonRun()`, and rethrow. Never release a claim while leaving the run registered active, and never retain a live registration without its claim.
- [ ] Store the artifact-aware snapshot in `unit.result` and `details.results`; never assign the mutable runtime object by reference.
- [ ] Remove/suppress low-level terminal `onUpdate` emissions in `execution.ts` and `pi-rpc-execution.ts`. Their running/provisional emissions must use the phase-aware snapshot that omits authoritative payloads, including the final assistant `message_end`; emit the authoritative terminal parent update only after `finishUnit()` succeeds.
- [ ] Preserve ordering for abort/error paths. If a native child session exists, artifact failure does not delete or rewrite it.
- [ ] Extend `InteractiveContinuationDetails` with exact-one-of `output` / `outputRef`. Before `sendMessage`, reserve the activation in the exactly-once/in-flight set, externalize oversized continuation text through `RunStore`, and inject only a bounded descriptor; on artifact failure inject a bounded error/status without the original oversized text. Wire `RunStore` through `index.ts`, track the async relay promise, and catch every rejection.
- [ ] Add controlled-promise tests proving ordering: artifact publish -> strict unit/final-run durable reference update -> unit/run terminal publication -> parent/relay callback. Include duplicate settle while relay artifact I/O is pending and a failed strict write followed by a coalesced flush.
- [ ] Simulate unit write, Chain collect artifact, and final-run write failures; assert no path reports success or later flushes a rejected terminal clone with a dangling/missing ref. For finalization failure, assert the live registration is removed before the claim is abandoned and a later process can inspect/claim the last strictly persisted state.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/chain.test.ts tests/execution.test.ts tests/pi-rpc-execution.test.ts tests/interactive-relay.test.ts)`
- Expected: no terminal callback or completed durable unit precedes artifact publication and durable reference flush.

### Task 7: Preserve Chain, Fanout, and Resume Semantics

**Outcome:** Large outputs move through file references without injecting megabytes into prompts, while structured expansion and frozen mappings remain deterministic and resumable.

**Files:**

- Create: `packages/pi-agents/src/artifact-reader-extension.ts`
- Modify: `packages/pi-agents/src/types.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Modify: `packages/pi-agents/src/chain.ts`
- Modify: `packages/pi-agents/src/template.ts`
- Modify: `packages/pi-agents/src/security.ts`
- Modify: `packages/pi-agents/src/invocation.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Modify: `packages/pi-agents/src/resume.ts`
- Modify: `packages/pi-agents/src/tool.ts`
- Modify: `packages/pi-agents/package.json`
- Create: `packages/pi-agents/tests/artifact-reader-extension.test.ts`
- Modify: `packages/pi-agents/tests/chain.test.ts`
- Modify: `packages/pi-agents/tests/security.test.ts`
- Modify: `packages/pi-agents/tests/invocation.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/resume.test.ts`

**Steps:**

- [ ] Add inline/reference fields to `ChainOutputEntry` and durable `WorkflowFanoutState`, plus a runtime-only `ResolvedWorkflowFanoutState` whose `items` is always a verified array. Durable refs must never be replaced with hydrated arrays in `run.json`.
- [ ] Build `artifact-reader-extension.ts` as a separate published entry. Register only `pi_agents_read_artifact`, accept run ID/digest plus byte offset/limit (no path), derive and verify the content-addressed file under the environment-provided exact run directory, return at most 48 KiB on a UTF-8 boundary, and include `nextOffsetBytes`/EOF metadata.
- [ ] Add a package `postbuild` command that builds `src/artifact-reader-extension.ts` to `dist/artifact-reader-extension.js`; keep Pi imports type-only so this child entry does not bundle a second host SDK. Resolve the shipped path from `import.meta.url` rather than cwd.
- [ ] Extend child invocation/security options with `artifactReaderRoot`. For Pi steps whose rendered task contains a descriptor, pass the explicit extension path and private `PI_AGENTS_RUN_ARTIFACT_DIR=<exact run dir>` environment and force-add only `pi_agents_read_artifact` to the child allowlist. Do not grant general filesystem access. Reject artifact handoff to Grok ACP before unit registration with `artifact_handoff_unsupported`.
- [ ] For `{previous}` and `{outputs.<name>}`, keep existing inline substitution for small values. For references, substitute a bounded descriptor that instructs the guaranteed dedicated tool; set `artifactReaderRoot` on that step request.
- [ ] For `outputSchema`, complete extraction and validation before terminal externalization.
- [ ] Before `readJsonPointer`, fanout expansion, or internal structured collection, resolve and verify a structured artifact through `RunStore`; never trust path/ref fields directly.
- [ ] Externalize a collected Chain text/structured value above the threshold and reuse the underlying result artifact when digest/media type match.
- [ ] Externalize frozen fanout `items` above the threshold before the expansion durability barrier. Persist `itemsRef`, `unitIds`, and queued child-unit records atomically through `store.updateRunStrict()` before scheduling any worker; ordinary `updateRun()` is forbidden at this side-effect boundary.
- [ ] Reject an individual fanout item above 256 KiB with `fanout_item_too_large`; do not silently replace the established `{item}` value contract. Overall mappings may still spill when several individually valid items cross the aggregate threshold.
- [ ] Update every coordinator fanout path (`mirrorAuthoritativeToLive`, equality/idempotency checks, expansion capture, disk mirror, and returned snapshots) to copy/compare the inline/reference union. When comparing a fresh inline expansion with a stored ref, externalize the candidate and compare digest/media type rather than loading untrusted path text.
- [ ] Make `inspectResume()` and `validateFanoutResumeState()` async. Resolve and verify `itemsRef` during both pre-claim and post-claim inspection, then run the existing canonical bijection checks against a runtime-only resolved mapping. Update all tool/slash-command call sites to await inspection.
- [ ] Carry the post-claim `resolvedFanouts` map through `preflightAndClaim()` / the tool resume entry into `RestoredChainState`. `chain.ts` consumes only this hydrated runtime map; coordinator/durable merge code continues to retain the original inline/reference record.
- [ ] On resume, missing, tampered, oversized, or unparsable artifacts produce `artifact_missing` / `artifact_corrupt` and stop before dispatch. Never reinterpret a missing completed-unit artifact as incomplete work and never recompute an existing fanout mapping from mutable upstream output.
- [ ] Add tests for: dedicated reader chunk continuation and long single-line payloads; no path escape; large sequential previous output; Pi/Grok handoff gating; large named text and structured output; aggregate mapping spill with individually bounded items; current-run and resumed fanout expansion; runtime hydration not persisted; inline/ref idempotency; pre/post-claim corruption; and unchanged execution order/attempt counts.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts tests/chain.test.ts tests/security.test.ts tests/invocation.test.ts tests/run-coordinator.test.ts tests/resume.test.ts tests/run-store.test.ts)`
- Expected: small workflows are byte-for-byte equivalent in model handoff text, large sequential handoffs use the dedicated bounded reader, oversized individual fanout items fail before scheduling, artifact-backed mappings hydrate only in runtime state, and corrupt artifacts fail without redispatching completed units.

### Task 8: Update Rendering and Documentation

**Outcome:** Users can identify, inspect, retain, and remove artifact-backed results without mistaking descriptors for the authoritative content.

**Files:**

- Modify: `packages/pi-agents/src/render.ts`
- Modify: `packages/pi-agents/tests/render.test.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/docs/how-to.md`

**Steps:**

- [ ] In expanded rendering, show payload kind, formatted size, validated path, and digest prefix for refs; do not synchronously load artifact contents.
- [ ] Keep collapsed summary lines unchanged apart from the existing status/error behavior.
- [ ] Add `artifacts/sha256/...` to the durable run directory diagram.
- [ ] Document the 2 MiB ordinary RPC cap, 64 MiB projectable replayable-event cap, canonical-shape compatibility fallback, settle-time session rehydrate, 256 KiB inline threshold, and 64 MiB artifact cap.
- [ ] Explain that `agent_end.messages` is wholly redundant, that oversized transcript/tool event payloads are recovered from native `sessionFile` before settle, and that `get_messages` is disabled in this integration.
- [ ] Document artifact reference fields, exact-one-of rules, error codes, Chain descriptor behavior, and verified lazy structured resolution.
- [ ] Add a how-to example for parent/user inspection with the displayed absolute path and ordinary `read`, plus a separate Chain example showing repeated `pi_agents_read_artifact` calls with `nextOffsetBytes`. The dedicated tool supports bounded byte chunks even when the authoritative artifact contains a long single line.
- [ ] Update privacy/disk-growth guidance: artifacts may contain sensitive model/tool output, inherit the run directory's manual retention, and disappear when the complete inactive run directory is removed.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/render.test.ts tests/interactive-relay.test.ts)`
- Expected: artifact references render without loading payloads and large continuation relays remain bounded.

- Run: `rg -n "agent_end|2 MiB|64 MiB|256 KiB|get_messages|artifact|sha256|sessionFile|pi_agents_read_artifact" packages/pi-agents/README.md packages/pi-agents/docs/{reference,explanation,how-to}.md`
- Expected: every limit, authority boundary, inspection path, dedicated reader contract, and retention rule is documented consistently.

## Final Validation

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: TypeScript completes with no errors, including exact-one-of durable unions and async terminal plumbing.

- Run: `mise run test --package packages/pi-agents`
- Expected: all package tests pass, including the synthetic 2.2-MiB aggregate event, 4-MiB final-message rehydrate, artifact durability, Chain/fanout, resume, rendering, and memory regressions.

- Run: `mise run build --package packages/pi-agents`
- Expected: `packages/pi-agents/dist/index.js` and `packages/pi-agents/dist/artifact-reader-extension.js` build successfully and the package includes every new runtime module.

- Run: `hk check`
- Expected: repository ESLint and Prettier checks pass with no modified-file violations.

- Run: `rg -n "getMessages\(|request\(\{ type: ['\"]get_messages" packages/pi-agents/src`
- Expected: no callable `get_messages` production path remains.

- Run: `rg -n "case ['\"]agent_end|\.messages" packages/pi-agents/src/interactive-agent.ts packages/pi-agents/src/pi-rpc-execution.ts packages/pi-agents/src/interactive-relay.ts`
- Expected: lifecycle consumers still do not use `agent_end.messages`; transcript use remains tied to streamed message events/snapshots.

- Run two focused fake-child integrations: (1) the observed small context-window error followed by a 2.2-MiB canonical `agent_end`; (2) cumulative oversized `message_update`, `message_end`, `turn_end`, and `agent_end` around a persisted 4-MiB assistant message, followed by `agent_settled`.
- Expected: the transport stays synchronized, preserves the observed model error, projects every eligible oversized event, rehydrates the 4-MiB finalized transcript before terminal publication, and never reports `stdout_overflow`.

- Run the memory-regression fixture with 4 MiB final text, 4 MiB structured output, and eight fanout items.
- Expected: authoritative artifact files verify; parent `details` and pretty-printed `run.json` remain below the thresholds established by the compact snapshot plan; no raw 4 MiB payload is duplicated into parent/durable records.

## Rollout Notes

1. Merge Tasks 1-2 first as the independent transport hotfix. This immediately prevents the observed Reviewer failure.
2. Land Task 3 as a separate transport-hardening change because disabling an unused command is not required for the overflow fix.
3. Complete the compact snapshot prerequisite plan before Tasks 5-8. Do not externalize mutable parser results directly.
4. Merge Tasks 4-8 together or behind an internal code path until all Chain/resume tests pass; a partial artifact schema without resolvers is unsafe.
5. No durable schema version bump is required because all reference fields are additive to Version 1 and legacy inline records remain readable.
6. Do not rewrite historical `run.json` or session files automatically. Existing failed runs remain inspection evidence; new code applies to new terminal snapshots and resumed records when they are next normalized.
7. If a future Pi version changes an eligible oversized event's key order, the local projector intentionally returns to the ordinary 2 MiB failure. Treat that as a compatibility signal to update the projector/tests, not as permission to broaden the global cap.

## Risks and Mitigations

- **The local projector depends on Pi's current eligible-event key order.** — Restrict every exception to an exact early prefix, fully validate the entire JSON token stream, keep a 64 MiB hard cap, and fail closed on shape changes.
- **A custom bracket scanner could accept malformed JSON.** — Implement a complete incremental tokenizer/state machine and exhaustive malformed/chunk-boundary tests; never emit until EOF/LF validation completes.
- **Projection could reorder events under stream backpressure.** — Process one record state at a time and do not advance into later bytes until the current projected record is complete; replayable-event projection performs no artifact I/O.
- **Artifact refs could become durable before files.** — Publish and sync content first, then await the run-record update and terminal event before parent delivery.
- **Artifact paths could escape the run or follow symlinks.** — Derive paths from digest only; validate containment, regular-file status, no symlink, exact bytes, and digest on every read.
- **Externalization could break Chain semantics or strand an agent without file access.** — Keep authority fields separate from descriptors, validate before externalization, inject only the run-scoped dedicated reader for Pi handoff steps, reject unsupported runtimes before dispatch, resolve structured refs only inside trusted workflow code, and test current/resumed fanout paths.
- **Settle-time transcript hydration could read before Pi persists the omitted message.** — Rely on Pi's event order only at `agent_settled`, verify the hydrated branch contains the expected post-baseline finalized message, and fail with `hydrate_error` rather than publishing incomplete output.
- **Missing artifacts could cause duplicate side effects on resume.** — Fail the resume with explicit artifact errors; never downgrade completed work to queued or recompute frozen fanout mappings.
- **Artifacts increase privacy and disk exposure.** — Reuse the private run directory, avoid duplicate transcript artifacts, document manual retention, and delete only the complete inactive run directory.
- **The 64 MiB artifact/projectable limits may be insufficient for a future workload.** — Fail with explicit size errors and collect measurements before introducing configuration; do not silently raise safety bounds.
- **`StringDecoder` replaces invalid UTF-8 before JSON validation.** — Define the projector guarantee over the decoded character stream, preserve current transport behavior, and add an invalid-byte regression proving deterministic handling; raw-byte UTF-8 rejection is outside this scoped change.
