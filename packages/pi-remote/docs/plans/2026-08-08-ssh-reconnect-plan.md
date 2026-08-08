# Implementation Plan

**Goal:** Make SSH failures bounded and recoverable on later invocations while preserving at-most-once execution for each current remote operation and correctly distinguishing missing paths from SSH failures.

**Inputs:** SSH reconnect recommendations confirmed on 2026-08-08; current `packages/pi-remote` source, tests, and README; OpenSSH 10.3p1 behavior and the official `ssh_config(5)` definitions for `ControlMaster`, `ControlPersist`, `ServerAliveInterval`, `ServerAliveCountMax`, `ConnectTimeout`, and `ConnectionAttempts`.

**Assumptions:**

- OpenSSH exit status `255` is not a reliable transport-only signal because a remote command can also exit with `255`. The implementation will not add a transport-specific UI hint. The README will use neutral wording about later invocations.
- A failed child process does not invalidate the session-owned `SshConnection`. The next `spawn()` call on the same object lets `ControlMaster=auto` reuse a live master or establish a new one.
- Existing package tests pass before the first Red step. The implementer will confirm this with the package test command.
- Tests will use an explicit remote path such as `user@host:/remote/path`. This avoids an unrelated startup `pwd` command.

**Architecture:** Keep one session-owned `SshConnection` and one private control path. Add fixed OpenSSH liveness and connection bounds to every normal `spawn()` call, but do not delete sockets, replace the connection, or retry a command. Represent a completed SSH command failure with its exit status inside `src/index.ts`, so only `test -e` status `1` maps to “missing”; all process and other SSH errors continue through the registered tool `execute` boundary.

**Tech Stack:** TypeScript, Bun test runner, OpenSSH CLI, Pi extension APIs and pluggable tool operations, mise, hk.

---

## File Map

- Modify: `packages/pi-remote/src/ssh.ts` — add fixed liveness and connection-attempt options to `SshConnection.spawn()` without changing connection ownership or cleanup.
- Modify: `packages/pi-remote/src/index.ts` — preserve SSH command exit status and classify only remote `test -e` status `1` as a missing path for `ls` and `find`.
- Test: `packages/pi-remote/tests/ssh.test.ts` — verify the exact public `SshConnection.spawn()` argv and next-invocation behavior after a failed child.
- Test: `packages/pi-remote/tests/index.test.ts` — verify `ls` and `find` behavior through tools registered by `registerPiRemote()`.
- Modify: `packages/pi-remote/README.md` — document bounded failure detection, later-invocation reconnect behavior, no replay, and path-existence error semantics.

No new source or test module is required. Keep shared test setup in the existing test files.

## Seams

These are the proposed public seams. Confirm them with the user before implementation starts. Do not test `sshExec`, an error predicate, or any other private helper directly.

- **Seam:** `SshConnection.spawn(command)` exported from `packages/pi-remote/src/ssh.ts` — verifies exact OpenSSH options, one child per invocation, reuse of the same control path, and a later invocation after a failed child.
- **Seam:** `execute(...)` on the registered `ls` tool captured from `registerPiRemote()` — verifies that remote `test -e` status `1` means missing while SSH/process failures propagate and are not replayed.
- **Seam:** `execute(...)` on the registered `find` tool captured from `registerPiRemote()` — verifies the same missing-versus-failure distinction before remote glob execution.

## TDD Execution Rules

- Run the baseline first: `mise run test --package packages/pi-remote`.
- Expected baseline: all existing package tests pass.
- Complete one task before starting the next. For each task, make the named test fail for the stated reason, then add only the minimal production change.
- Use literal expected OpenSSH argv values in tests. Do not import newly named option constants into tests; the confirmed requirements are the independent source of truth.
- Count fake child processes or recorded spawn calls to prove that one invocation does not replay itself.
- Do not create an injectable retry, socket-removal, or connection-replacement seam.

## Tasks

### Task 1: Bound SSH failure detection and preserve next-invocation reconnect

**Seam:** `SshConnection.spawn(command)`

**Outcome:** Every normal SSH child receives the four fixed options. A failed child is not replayed, and a later call uses the same `SshConnection` and control path so OpenSSH can reconnect automatically.

**Files:**

- Modify: `packages/pi-remote/tests/ssh.test.ts`
- Modify: `packages/pi-remote/src/ssh.ts`

**Steps:**

- [ ] **Red:** In `packages/pi-remote/tests/ssh.test.ts`, replace or narrow the existing test `adds multiplexing options and reuses one control path` with one public-boundary scenario that:
  - Creates a connection through `createSshConnection()` with the existing spawn recorder.
  - Calls `conn.spawn('echo hi')` once.
  - Emits `close` with status `255` on that first fake child to model a failed in-flight SSH command.
  - Asserts that the recorder still has exactly one process call. This proves that the failed invocation was not replayed.
  - Calls `conn.spawn('ls -la')` as a separate, later invocation.
  - Asserts that the recorder now has exactly two calls and that both calls use the same `ControlPath` value.
  - Asserts that each normal call has this exact argv order before the remote and command:
    - `-o`, `ControlMaster=auto`
    - `-o`, `ControlPersist=${CONTROL_PERSIST}`
    - `-o`, `ControlPath=${conn.controlPath}`
    - `-o`, `ServerAliveInterval=15`
    - `-o`, `ServerAliveCountMax=3`
    - `-o`, `ConnectTimeout=15`
    - `-o`, `ConnectionAttempts=2`
  - Keeps the existing `stdio` assertion `['ignore', 'pipe', 'pipe']`.
- [ ] **Green:** In `packages/pi-remote/src/ssh.ts`, define descriptive internal constants for the non-trivial values `15`, `3`, `15`, and `2`. Append the four fixed `-o` pairs to the normal `SshConnection.spawn()` options. Do not add them to the `ssh -O exit` cleanup command.
- [ ] **Green constraint:** Do not catch child failures in `SshConnection`, call `close()`, remove the private directory/socket, create a new `SshConnection`, or call `spawnSsh()` a second time for one `spawn()` invocation.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`
- Expected: the updated spawn test fails because the four required option pairs are absent from recorded argv. The one-call-after-failure assertion already passes.
- Run (green): `mise run test --package packages/pi-remote`
- Expected: all package tests pass; the test records exactly two SSH children for two explicit invocations and identical control paths.

### Task 2: Propagate `ls` SSH failures while retaining missing-path behavior

**Seam:** Registered `ls.execute(...)` from `registerPiRemote()`

**Outcome:** `ls` reports a missing path only when remote `test -e` completes with status `1`. Status `255`, other nonzero statuses, and child `error` events propagate through `execute()` without a replay.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`

**Steps:**

- [ ] **Red:** Extend the existing `registerPiRemote` harness in `packages/pi-remote/tests/index.test.ts` only as needed to select a registered tool by its public `name`. Add one test named for the full distinction, for example `ls treats only test status 1 as a missing path`. Use `user@host:/remote/path`, run `session_start`, and exercise the captured `ls.execute()` boundary with these sub-scenarios:
  - Invoke `ls.execute('ls-transport', { path: 'lost' }, undefined, undefined)`. On its one fake child, write `Connection reset` to stderr and emit `close` with status `255`. Expect rejection containing `SSH failed (255): Connection reset`, and expect no `Path not found` text. Assert one spawn call for this invocation.
  - Invoke `ls.execute('ls-missing', { path: 'missing' }, undefined, undefined)`. Emit `close` with status `1` on its `test -e` child. Expect rejection containing `Path not found:` for the absolute tool path resolved from the local cwd. Path remapping remains internal to the remote operation. Assert that no `stat` or `readdir` child was started for this invocation.
  - Invoke `ls.execute('ls-process-error', { path: 'broken' }, undefined, undefined)`. Emit `error` with `new Error('ssh process failed')` on its child. Expect that same message to propagate. Assert one spawn call for this invocation.
- [ ] **Green:** In `packages/pi-remote/src/index.ts`, make failures created by `sshExec()` retain the completed child exit status while preserving the current human-readable message. Use an internal error type or equivalent internal representation; do not export it for tests.
- [ ] **Green:** Add one internal classification predicate for `test -e`: return `false` only when the retained exit status is exactly `1`; rethrow every other error unchanged. Apply it only to `createRemoteLsOps().exists` in this slice.
- [ ] **Green constraint:** Do not infer “transport error” from status `255`. Do not retry `test -e`, the full `ls` operation, or any registered tool call.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`
- Expected: the new `ls` test fails because the current rejection handler converts status `255` and the child `error` event into `false`, after which the public tool throws `Path not found`.
- Run (green): `mise run test --package packages/pi-remote`
- Expected: all package tests pass; status `1` produces `Path not found`, while status `255` and process errors retain their original SSH/process messages with one child per invocation.

### Task 3: Apply the existence rule to `find` and publish the behavior contract

**Seam:** Registered `find.execute(...)` from `registerPiRemote()`

**Outcome:** `find` uses the same exact missing-path rule as `ls`, SSH failures stop before glob execution, and the README states the reconnect and no-replay contract without claiming reliable status-255 classification.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`
- Modify: `packages/pi-remote/README.md`

**Steps:**

- [ ] **Red:** Add one test in `packages/pi-remote/tests/index.test.ts`, for example `find treats only test status 1 as a missing search path`, through the captured registered `find.execute()` boundary:
  - Start with `user@host:/remote/path`.
  - Invoke `find.execute('find-transport', { pattern: '*.ts', path: 'lost' }, undefined, undefined)`. Write `Broken pipe` to stderr and emit `close` with status `255` on the `test -e` child. Expect rejection containing `SSH failed (255): Broken pipe`, not `Path not found`. Assert that only the existence-check child was spawned; the `rg --files` glob command must not start.
  - Invoke `find.execute('find-missing', { pattern: '*.ts', path: 'missing' }, undefined, undefined)`. Emit `close` with status `1`. Expect rejection containing `Path not found:` and again assert that no glob child starts.
- [ ] **Green:** Reuse the internal status-aware predicate introduced in Task 2 in `createRemoteFindOps().exists`. Do not add a second classifier or change `glob()` behavior.
- [ ] **Green:** Update `packages/pi-remote/README.md` in the connection multiplexing and tool-behavior sections:
  - List `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `ConnectTimeout=15`, and `ConnectionAttempts=2` as fixed internal SSH options.
  - State that these values bound detection/connection attempts; they are not user configuration.
  - State that `ControlMaster=auto` handles recovery on a later invocation by reusing a live master or opening a new transport with the same session-owned connection/control path.
  - State that the failed current operation is never automatically replayed. Warn that `bash`, `write`, and `edit` can have partial or uncertain remote side effects, so the caller must inspect state before manually repeating them.
  - State that `ls` and `find` treat only remote `test -e` status `1` as missing and propagate SSH/process failures.
  - Use neutral wording: a later invocation starts another SSH attempt. Do not describe status `255` as definitively a transport failure and do not promise a new UI hint.
- [ ] **Green constraint:** Keep `registerPiRemote()` bound to the original session connection. Do not wrap `bash`, `write`, `edit`, or any other tool `execute()` method in retry logic.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`
- Expected: the new `find` test fails because status `255` is converted to `false` and surfaces as `Path not found`.
- Run (green): `mise run test --package packages/pi-remote`
- Expected: all package tests pass; the failed `find` existence check starts no glob child, and status `1` remains the only missing-path case.
- Inspect: `packages/pi-remote/README.md`
- Expected: all six behavior bullets above are present, and no text claims automatic replay, manual socket repair, or reliable transport classification from status `255`.

## Final Validation

Run in this order after all three Green steps:

- Run: `mise run test --package packages/pi-remote`
- Expected: all `pi-remote` tests pass, including the new public-seam scenarios.
- Run: `mise run typecheck --package packages/pi-remote`
- Expected: TypeScript reports no errors. The internal SSH error representation and registered-tool test calls are type-safe.
- Run: `mise run build --package packages/pi-remote`
- Expected: the package bundle builds successfully.
- Run: `hk check`
- Expected: repo-wide ESLint and Prettier checks pass with no changes required.

If a validation command fails for an unrelated pre-existing issue, record the exact command and output. Do not fix unrelated packages in this work.

## Failure Behavior

- The server stops responding to protocol-level liveness checks — OpenSSH disconnects after approximately `ServerAliveInterval × ServerAliveCountMax` (45 seconds); the current operation fails and is not replayed.
- A connection attempt exceeds `ConnectTimeout=15`, or both configured connection attempts fail — that invocation fails; a later invocation calls `spawn()` again on the same `SshConnection`.
- The multiplexed master is still healthy — OpenSSH reuses it through `ControlMaster=auto`.
- The multiplexed transport is no longer usable — a later OpenSSH invocation may establish a new master automatically; pi-remote does not delete the socket or reconstruct the connection object.
- Remote `test -e` exits `1` — `ls` or `find` reports `Path not found` and does not continue to `stat`, `readdir`, or glob execution.
- Remote `test -e` exits with any other status, or the local SSH child emits `error` — the original SSH/process failure propagates through the registered tool `execute()` promise.
- `bash`, `write`, or `edit` fails after remote execution may have started — report the failure without replay. The remote side effect can be partial or unknown.

## Privacy and Security

- Keep the current private mode-`0700`, process/session-unique control directory and hashed socket name. Do not include remote target details in the socket basename.
- Do not log SSH credentials, environment contents, command payloads, or file contents beyond existing tool error/output behavior.
- The fixed liveness options change failure timing only. They must not weaken host-key checks, authentication, or control-path ownership checks.

## Rollout Notes

- No migration or user configuration is required.
- Existing `ControlPersist=10m` and best-effort `ssh -O exit` shutdown behavior remain unchanged.
- The change affects every normal SSH child in the package. It does not add background processes or periodic traffic outside OpenSSH's per-connection server-alive behavior.

## Risks and Mitigations

- **Status `255` ambiguity:** A remote command can return the same status used by many SSH transport failures. — Keep error text neutral and use status only for the exact `test -e` status-`1` rule.
- **Accidental duplicate side effects:** A retry could repeat `bash`, `write`, or `edit`. — Keep retry logic absent, assert one child per invocation at public seams, and document manual state inspection before repetition.
- **Over-broad missing-path conversion:** Catching every SSH failure as `false` hides outages. — Retain exit status internally and convert only exact status `1` from `test -e`.
- **Cleanup regression:** Adding normal connection options to `ssh -O exit` could change shutdown behavior. — Limit new options to `SshConnection.spawn()` and retain existing cleanup argv tests.
- **Misleading reconnect claim:** OpenSSH decides whether it can reuse or recreate a master. — Document that later invocations attempt recovery; do not guarantee success.

## Out of Scope

- Background health checks or keepalive workers outside the requested OpenSSH options.
- Proactive `ssh -O check` calls.
- Manual control-socket deletion or private-directory repair during a session.
- Replacing or rebuilding the session's `SshConnection` after a child failure.
- Global automatic retries or replay of any failed in-flight operation.
- Special retry behavior for `bash`, `write`, or `edit`.
- User-configurable liveness, timeout, or attempt values.
- Transport-specific UI/error classification based only on exit status `255`.
- Unrelated refactoring of remote operations, autocomplete, lifecycle ownership, or cleanup.

## Open Questions

**Open Questions:** None.
