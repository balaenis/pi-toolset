# Durable LSP Diagnostics Implementation Plan

**Goal:** Deliver LSP diagnostics as durable hidden custom messages before the next naturally occurring LLM provider request instead of injecting them only through ephemeral context transforms.

**Inputs:** User discussion on 2026-06-23; repository evidence from `packages/pi-lsp/src/index.ts`, `packages/pi-lsp/src/diagnostics.ts`, `packages/pi-lsp/tests/diagnostics.test.ts`, `packages/pi-lsp/README.md`; Pi extension API evidence from `before_agent_start`, `context`, and `sendMessage(..., { deliverAs })` types and runtime behavior.

**Assumptions:**

- This is an extension-only change; Pi core event ordering and provider-request hooks will not be changed in this pass.
- `before_agent_start` custom messages are durable because Pi adds them to the prompt message list and persists them through normal `message_end` handling.
- `context` hook output remains ephemeral and must not be the primary diagnostic delivery path.
- Diagnostics collected after a successful `edit` or `write` tool result may be queued with `deliverAs: "steer"` because those built-in tools do not set `terminate` and Pi naturally performs a follow-up provider request after tool results.
- Diagnostics that arrive too late to be queued before the current run’s next provider request remain pending and are delivered by `before_agent_start` on the next user prompt.

**Architecture:** Move diagnostic delivery from the `context` hook to durable custom-message delivery. Add a small helper that drains pending diagnostics only when constructing a hidden `lsp-diagnostics` message, use `before_agent_start` for idle-to-next-user-prompt delivery, and queue a `steer` custom message after successful edit/write sync when diagnostics are available during an active tool turn. Keep the existing diagnostic registry’s deduplication, throttling, and status-line semantics intact.

**Tech Stack:** TypeScript, Pi extension lifecycle hooks, Bun test runner, existing `diagnostics` registry, `@earendil-works/pi-coding-agent` extension API.

---

## File Map

- Create: `packages/pi-lsp/src/diagnostic-delivery.ts` — centralizes the hidden custom-message shape and drains pending diagnostics only when a durable delivery is being created.
- Modify: `packages/pi-lsp/src/index.ts` — replaces ephemeral `context` injection with `before_agent_start` durable injection and queues durable diagnostics after successful edit/write sync.
- Modify: `packages/pi-lsp/README.md` — documents that passive diagnostics are delivered as hidden durable session messages before the next LLM request.
- Test: `packages/pi-lsp/tests/diagnostic-delivery.test.ts` — verifies diagnostic-message construction, drain behavior, and no-message behavior when no diagnostics are pending.
- Test: `packages/pi-lsp/tests/index.test.ts` — verifies extension wiring registers `before_agent_start`, no longer registers diagnostic delivery through `context`, and queues durable messages with `deliverAs: "steer"` after edit/write sync when diagnostics are available.

## Tasks

### Task 1: Add a durable diagnostic-message helper

**Outcome:** Diagnostic custom-message creation is isolated from lifecycle wiring, and `diagnostics.drain()` is called only when creating a durable message.

**Files:**

- Create: `packages/pi-lsp/src/diagnostic-delivery.ts`
- Test: `packages/pi-lsp/tests/diagnostic-delivery.test.ts`

**Steps:**

- [ ] Create `packages/pi-lsp/src/diagnostic-delivery.ts` with the required `ABOUTME` header.
- [ ] Move `DIAGNOSTIC_CUSTOM_TYPE = 'lsp-diagnostics'` from `packages/pi-lsp/src/index.ts` into this helper and export it.
- [ ] Define an exported `DiagnosticMessage` type as `Pick<CustomMessage, 'customType' | 'content' | 'display' | 'details'>` imported from `@earendil-works/pi-coding-agent`.
- [ ] Add `drainDiagnosticMessage(cwd: string): DiagnosticMessage | undefined` that calls `diagnostics.drain(cwd)`, returns `undefined` when the drain returns `null`, and otherwise returns:

  ```ts
  {
    customType: DIAGNOSTIC_CUSTOM_TYPE,
    content: block,
    display: false,
    details: { source: 'pi-lsp' },
  }
  ```

- [ ] Keep timestamp assignment out of the helper because Pi adds timestamps when `before_agent_start` messages or `sendMessage` messages are inserted.
- [ ] In `packages/pi-lsp/tests/diagnostic-delivery.test.ts`, register one diagnostic through `diagnostics.register('ts', uri, [diag])`, call `drainDiagnosticMessage(cwd)`, and assert the returned message has `customType: 'lsp-diagnostics'`, `display: false`, `details.source === 'pi-lsp'`, and content containing the diagnostic message and formatted file path.
- [ ] Add a test that calls `drainDiagnosticMessage(cwd)` with no pending diagnostics and asserts it returns `undefined`.
- [ ] Add a test that calls `drainDiagnosticMessage(cwd)` twice after one registered diagnostic and asserts the first call returns a message and the second call returns `undefined`, proving the helper does not duplicate an already-drained batch.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/diagnostic-delivery.test.ts tests/diagnostics.test.ts`
- Expected: the new helper tests pass and the existing diagnostic registry tests still pass.

### Task 2: Replace ephemeral context injection with before-agent durable injection

**Outcome:** Diagnostics pending before a user prompt become hidden custom messages in the persisted session history before the prompt’s first provider request.

**Files:**

- Modify: `packages/pi-lsp/src/index.ts`
- Test: `packages/pi-lsp/tests/index.test.ts`

**Steps:**

- [ ] Remove the existing `pi.on('context', ...)` diagnostic injection block from `packages/pi-lsp/src/index.ts`.
- [ ] Remove the now-stale comment that describes context output as ephemeral.
- [ ] Import `drainDiagnosticMessage` from `./diagnostic-delivery.ts`.
- [ ] Register a new `before_agent_start` handler:

  ```ts
  pi.on('before_agent_start', (_event, ctx) => {
    const message = drainDiagnosticMessage(ctx.cwd);
    if (!message) return;
    logForDebugging(`diagnostics: injecting durable block for ${ctx.cwd}`);
    return { message };
  });
  ```

- [ ] Remove the unused `AgentMessage` import from `packages/pi-lsp/src/index.ts` if it becomes unused after deleting the context hook.
- [ ] In `packages/pi-lsp/tests/index.test.ts`, create a minimal fake `ExtensionAPI` object that records handlers registered through `on`, records calls to `sendMessage`, and supplies no-op `registerTool` and `registerCommand` functions.
- [ ] Call the extension default export with the fake API and assert a `before_agent_start` handler is registered.
- [ ] Assert no `context` handler is registered for diagnostics delivery after the change.
- [ ] Register a diagnostic, invoke the captured `before_agent_start` handler with a fake context containing `cwd`, and assert the returned value is `{ message: ... }` with `customType: 'lsp-diagnostics'` and `display: false`.
- [ ] Invoke the captured `before_agent_start` handler again without registering another diagnostic and assert it returns `undefined`.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/index.test.ts tests/diagnostic-delivery.test.ts`
- Expected: the extension wiring test proves diagnostics are durable through `before_agent_start`, and helper tests prove no duplicate drain occurs.

### Task 3: Queue durable diagnostics after successful edit/write sync during an active run

**Outcome:** Diagnostics produced by a successful edit/write tool sync are queued as a durable hidden custom message for the current run’s natural post-tool provider request when available.

**Files:**

- Modify: `packages/pi-lsp/src/index.ts`
- Test: `packages/pi-lsp/tests/index.test.ts`

**Steps:**

- [ ] In the existing `pi.on('tool_result', ...)` handler, keep the current guards: ignore non-edit/write tools, ignore errored tool results, and ignore results without an input path.
- [ ] Keep the existing `diagnostics.clearForFile(uri)` call before sync so fresh diagnostics for the edited file can be delivered even if they match a previously delivered issue.
- [ ] After `await manager.syncFileChange(absolutePath)` and the existing post-sync missing-server notification check, call `const message = drainDiagnosticMessage(ctx.cwd)`.
- [ ] If `message` exists, log `diagnostics: queueing durable block for current run in ${ctx.cwd}` and call:

  ```ts
  pi.sendMessage(message, { deliverAs: 'steer' });
  ```

- [ ] Do not use `triggerTurn: true` or `deliverAs: 'followUp'`; diagnostics must not start an agent run or force a follow-up after the agent would otherwise stop.
- [ ] If `waitForInitialization()`, manager lookup, or `syncFileChange()` throws, keep the existing best-effort catch behavior and do not drain diagnostics in the catch block; pending diagnostics should remain available for `before_agent_start`.
- [ ] If `manager` is unavailable, do not drain diagnostics in this handler; leave them pending for `before_agent_start`.
- [ ] In `packages/pi-lsp/tests/index.test.ts`, use Bun module mocking or an extracted test seam to fake `waitForInitialization()`, `getManager()`, and `manager.syncFileChange()` so the tool-result handler can run without starting real LSP servers.
- [ ] Add a test that registers a diagnostic, invokes the captured `tool_result` handler with `{ toolName: 'edit', isError: false, input: { path: 'src/app.ts' } }`, and asserts `pi.sendMessage` was called once with a `lsp-diagnostics` message and `{ deliverAs: 'steer' }`.
- [ ] Add a test that invokes the handler with an errored edit result and asserts `pi.sendMessage` is not called and a subsequent `drainDiagnosticMessage(cwd)` still returns the diagnostic message.
- [ ] Add a test that makes `syncFileChange()` throw and asserts `pi.sendMessage` is not called and a subsequent `before_agent_start` invocation still returns the pending diagnostic message.

**Validation:**

- Run: `mise run test --package packages/pi-lsp -- tests/index.test.ts tests/diagnostic-delivery.test.ts tests/diagnostics.test.ts`
- Expected: successful edit/write sync queues durable diagnostics with `deliverAs: 'steer'`; failure paths do not drain or lose diagnostics; existing registry behavior remains unchanged.

### Task 4: Update README behavior documentation

**Outcome:** Users and maintainers can see that passive diagnostics are hidden durable session messages, not ephemeral context-only injections.

**Files:**

- Modify: `packages/pi-lsp/README.md`

**Steps:**

- [ ] In the introduction paragraph that currently describes passive diagnostics, add that diagnostics are delivered as hidden custom messages before the next LLM request and remain in session history.
- [ ] In the StatusLine indicator section, keep the existing status semantics but clarify that the error-colored bolt can represent diagnostics that are pending delivery or already delivered until an edit clears the file’s delivered tracking.
- [ ] In the companion-server section, keep the existing primary/companion routing explanation and add one sentence that diagnostics from primary and companion servers share the same durable delivery path.
- [ ] Do not add new configuration options because this change is behavior-only.

**Validation:**

- Run: `hk check`
- Expected: repository formatting and lint checks pass, including README formatting.

## Final Validation

- Run: `mise run test --package packages/pi-lsp -- tests/index.test.ts tests/diagnostic-delivery.test.ts tests/diagnostics.test.ts`
- Expected: all targeted tests pass.
- Run: `mise run typecheck --package packages/pi-lsp`
- Expected: TypeScript type checking passes with no errors.
- Run: `hk check`
- Expected: repo-wide lint and formatting checks pass.

## Rollout Notes

- No migration or configuration change is required.
- Existing sessions will keep their old transcript entries; the new durable delivery behavior applies to diagnostics collected after the updated extension loads.
- The visible UI remains unchanged because diagnostic custom messages continue to use `display: false`.
- If a diagnostic is drained and queued with `deliverAs: 'steer'`, Pi will persist it when the queued message is processed by the agent loop.

## Risks and Mitigations

- **Late asynchronous push diagnostics may arrive after the edit/write handler has already checked for pending diagnostics.** They remain in `diagnostics` pending state and are delivered by `before_agent_start` on the next user prompt; the implementation does not reintroduce ephemeral `context` injection.
- **`deliverAs: 'steer'` can force an extra turn if used outside a natural post-tool continuation.** The implementation only uses it after successful `edit`/`write` tool results, where Pi’s built-in tools naturally return tool results to the model; it never uses `followUp` or `triggerTurn`.
- **Calling `diagnostics.drain()` too early would mark diagnostics delivered before they are durable.** The helper is the only planned drain call site, and callers only invoke it immediately before returning a `before_agent_start` message or calling `pi.sendMessage`.
- **Tests that import the extension entry point may accidentally trigger manager startup.** The index tests should invoke only registered handlers with a fake API and mock manager functions for the tool-result path; they should not call `session_start` or start real LSP processes.
