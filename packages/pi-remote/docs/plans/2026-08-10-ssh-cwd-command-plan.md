# Implementation Plan

**Goal:** Add `/ssh:cwd` so users can change the active remote working directory with remote directory suggestions from `fd` and a `find` fallback.

**Inputs:** Requirements confirmed with Mr. Julian on 2026-08-10; `packages/pi-remote/src/index.ts`; `packages/pi-remote/tests/index.test.ts`; `packages/pi-remote/README.md`; Pi extension command and TUI documentation.

**Assumptions:**

- `/ssh:cwd` changes the shared remote root for all later SSH-backed tools, `!` commands, remote `@` completion, the status line, and the next system prompt.
- The change lasts only for the active SSH connection. A reconnect resolves its cwd from `/ssh`, `--ssh`, or remote `pwd` as it does now.
- Candidates are relative to the current remote cwd. The list always includes `..` as the first item, including when the current cwd is `/`.
- Completion and picker results contain at most 100 items total: `..` plus at most 99 discovered descendants. The remote lister can read at most 100 paths before client-side filtering and slicing.
- Case-insensitive fuzzy ranking uses this deterministic order: exact basename, basename prefix, basename substring, full-path substring, then ordered subsequence. Equal scores sort by normalized relative path using code-point order.
- Completion items use the full relative path as `value`, the basename as `label`, and the relative path as `description` when it differs from the label.
- Manual arguments support paths relative to the current remote cwd, absolute paths, exact `~`, and `~/...`, as confirmed in the argument-semantics and path-normalization decisions.
- Directory names can contain spaces. Newline characters in directory names are not supported because both `fd` and `find` return line-delimited output.
- The command does not persist cwd state in Pi session entries or configuration.

**Architecture:** Register the exact extension command name `ssh:cwd`; Pi treats the text before the first space as the command name, so the colon is valid. Keep the active cwd on the existing mutable `RemoteOperationContext`. Each operation factory already snapshots `remoteCwd` when an operation starts, so an in-flight operation keeps its old cwd while later operations read the new value. Use one remote Bash script to list directories: select `fd` when available and otherwise use `find`; normalize and fuzzy-rank the returned relative paths in TypeScript. Resolve a requested target on the remote with a safely quoted positional argument, `cd`, and `pwd`, then update shared state only after success.

**Tech Stack:** TypeScript, Bun test runner, Pi extension `registerCommand()` and `ctx.ui` APIs, OpenSSH, remote Bash, `fd`, POSIX `find`, mise, hk.

---

## File Map

- Modify: `packages/pi-remote/src/index.ts` — add remote directory listing, fuzzy candidate generation, safe cwd resolution, shared-state update, and `/ssh:cwd` registration.
- Test: `packages/pi-remote/tests/index.test.ts` — verify the registered command, argument completions, fallback behavior, cwd switching, state propagation, and failures through public extension interfaces.
- Modify: `packages/pi-remote/README.md` — document `/ssh:cwd`, candidate scope, `fd`/`find` behavior, state lifetime, and failure behavior.

No new source module is required. Keep the SSH adapter and command state next to the existing `/ssh` wiring. Do not modify `src/remote-autocomplete.ts`; its public behavior changes automatically because its factory reads `resolvedSsh.remoteCwd` for each request.

## Seams

These seams were confirmed by the approved command behavior and implementation-plan request.

- **Seam:** The command objects captured from `ExtensionAPI.registerCommand()` in `registerPiRemote()` — verifies that `ssh:cwd` is registered and handles connected, disconnected, explicit-argument, and no-argument flows.
- **Seam:** `ssh:cwd.getArgumentCompletions(prefix)` — verifies async remote directory discovery, case-insensitive fuzzy filtering, candidate values, the 100-item total cap, `..`, and failure-to-`null` behavior.
- **Seam:** `SshConnection.spawn(command)` as observed through the injected `FakeSshConnection` — verifies the remote adapter command that selects `fd` or `find`, including traversal, exclusion, and output-limit rules.
- **Seam:** Existing public consumers returned or registered by `registerPiRemote()` — verifies that a successful switch affects later `user_bash`, registered tool execution, remote `@` completion, status output, and `before_agent_start`, while an already-started operation keeps its old cwd.

Mr. Julian confirmed that the plan must cover implementation and unit tests. These are the proposed public seams selected from the current extension API. Confirm this seam list at implementation kickoff before writing the first Red test. Do not export private listing, scoring, quoting, or cwd-resolution helpers only to test them.

## TDD Execution Rules

- Baseline command: `mise run test --package packages/pi-remote`.
- Verified baseline on 2026-08-10: 46 tests pass and 0 fail.
- Complete each task as one Red→Green slice before starting the next task.
- Test through captured command handlers, command completions, event handlers, registered tools, and autocomplete providers. Do not directly test private helpers.
- Use literal expected commands, paths, labels, descriptions, notifications, and statuses. Do not import implementation constants into tests.
- Use `FakeSshConnection` and `FakeChild`. Do not open a real SSH connection for the new scenarios.

## Tasks

### Task 1: Register `/ssh:cwd` and reject disconnected use

**Seam:** Captured `ssh:cwd` command object from `registerPiRemote()`

**Outcome:** The command exists. Without an active SSH connection, completion returns `null` without spawning a process, and execution shows an actionable error instead of falling back to local behavior.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`

**Steps:**

- [ ] **Red:** Extend the test command type to include optional async `getArgumentCompletions`. Add one test named `registers ssh:cwd and rejects use without an SSH connection`.
- [ ] In the test, create the harness without an SSH flag and select the command whose name is `ssh:cwd`.
- [ ] Assert that the command exists and its description says that it changes the remote working directory.
- [ ] Call `getArgumentCompletions('abc')`; expect `null` and no SSH connection or child process.
- [ ] Call `handler('abc', ctx)`; expect one error notification with the actionable text `No active SSH connection. Use /ssh first.` and no connection attempt.
- [ ] **Green:** Register `pi.registerCommand('ssh:cwd', ...)` near the existing `/ssh` command.
- [ ] Make both completion and handler read the current `resolvedSsh` at invocation time. Do not capture a connection during extension registration.
- [ ] Return `null` from completion when disconnected. Notify and return from the handler when disconnected.
- [ ] Do not call `getSsh()` for this check because a previous SSH startup failure must produce the same user-facing “connect first” behavior, not throw from autocomplete.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`.
- Expected: the new test fails because no `ssh:cwd` command is registered.
- Run (green): `mise run test --package packages/pi-remote`.
- Expected: all package tests pass; disconnected use has no SSH or local side effects.

### Task 2: Provide `fd` directory completions

**Seam:** `ssh:cwd.getArgumentCompletions(prefix)`

**Outcome:** A connected user receives relative directory candidates from remote `fd`, filtered and ranked in TypeScript, with `..` always available.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`

**Steps:**

- [ ] **Red:** Add one test named `offers fuzzy fd directory completions under the current remote cwd`.
- [ ] Start the harness with `user@host:/remote/project` so startup does not issue `pwd`.
- [ ] Invoke `getArgumentCompletions('AbC')` and inspect the single remote child command.
- [ ] Assert that the command runs under `/remote/project` and invokes `fd` for directories only with these fixed rules: hidden entries included, symlinks followed, `.git` excluded, color disabled, and at most 100 results.
- [ ] Feed line-delimited paths that cover an exact basename, basename prefix, basename substring, full-path substring, an ordered-subsequence-only match, a non-match, a path with spaces, and a `.git` path.
- [ ] Assert case-insensitive fuzzy ordering in this priority: exact basename, basename prefix, basename substring, path substring, ordered subsequence. Use the relative path as `value`, the basename as `label`, and the relative path as `description` when it adds context.
- [ ] Assert that `..` is the first item even though it does not match `AbC`; `.git`, `.`, and the non-match are absent.
- [ ] Feed more than 99 matching descendants and assert that the final result contains exactly 100 items total: `..` plus 99 descendants.
- [ ] **Green:** Add descriptive constants for the 100-path remote listing cap and the 100-item final candidate cap.
- [ ] Add a remote directory lister that runs `fd` from the current `remoteCwd` and returns normalized relative directory paths. Strip leading `./` and trailing `/`, reject empty paths, `.`, and every `.git` segment, deduplicate paths, and stop reading after the remote listing cap.
- [ ] Add case-insensitive scoring in TypeScript with the exact priority tested above. Break equal scores by normalized relative path using direct code-point comparison, not locale-dependent collation.
- [ ] Prepend `..`, then slice discovered matches to `FINAL_CANDIDATE_CAP - 1` so completion and picker each contain at most 100 total items.
- [ ] Build `AutocompleteItem` values from the complete relative path. Do not add a trailing slash because selecting an item must produce an executable `/ssh:cwd <path>` argument.
- [ ] Catch listing errors in `getArgumentCompletions` and return `null`; autocomplete must not throw into the editor.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`.
- Expected: the new completion test fails because connected completion still returns `null` and starts no `fd` child.
- Run (green): `mise run test --package packages/pi-remote`.
- Expected: all package tests pass and the returned items match the fixed ranking and value contract.

### Task 3: Fall back to remote `find`

**Seam:** `ssh:cwd.getArgumentCompletions(prefix)`

**Outcome:** The same completion behavior works when remote `fd` is unavailable, without installing software or changing the public result shape.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`

**Steps:**

- [ ] **Red:** Add one test named `falls back to find when fd is unavailable` at the completion seam and its observable `SshConnection.spawn(command)` adapter boundary.
- [ ] Invoke connected completion and inspect the emitted remote adapter command. Require an explicit `command -v fd` branch and a `find` fallback. The pre-Task-3 `fd`-only script must fail this assertion.
- [ ] Require this fallback shape: `find -L . -mindepth 1 \( -type d -name .git -prune \) -o \( -type d -print \) | awk 'NR <= 100'`. Run it only after changing to the quoted current remote cwd. This excludes the starting `.`, follows symlinks, includes hidden directories, prunes `.git`, emits directories only, and caps output at 100 without closing the pipe early.
- [ ] Feed fallback-style `./path` output and assert through `getArgumentCompletions()` that completion returns the same normalized, fuzzy-ranked item shape as the `fd` path, including `..` and excluding `.`.
- [ ] Add a failure sub-scenario: emit a nonzero remote close with stderr and no output; expect `null`, not a rejected promise.
- [ ] **Green:** Wrap the remote listing in one Bash script with `set -o pipefail`: use `fd` when `command -v fd` succeeds; otherwise run the exact `find`/`awk` fallback above.
- [ ] Keep filtering and ranking in TypeScript for both branches. Do not use remote `grep` for fuzzy matching.
- [ ] Because `awk` continues to consume input after the first 100 records, it must not cause a SIGPIPE false failure. With `pipefail`, genuine `find` and SSH failures still return nonzero.
- [ ] Do not install `fd`, modify remote files, or add a local package dependency.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`.
- Expected: the fallback test fails because the remote command has no `command -v fd` or `find` branch.
- Run (green): `mise run test --package packages/pi-remote`.
- Expected: all package tests pass; both remote tools produce the same completion contract and errors return `null`.

### Task 4: Switch an explicit relative cwd and propagate shared state

**Seam:** `ssh:cwd.handler(args, ctx)` plus existing registered SSH consumers

**Outcome:** `/ssh:cwd <relative-path>` resolves the target remotely, updates state only after success, and changes every later remote-facing interface while preserving the cwd of an already-started operation.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`

**Steps:**

- [ ] **Red:** Add one test named `switches shared remote cwd after an explicit relative path succeeds`.
- [ ] Connect at `/remote/project` and start one `user_bash` operation before invoking `ssh:cwd`; assert that its already-created command uses `/remote/project`.
- [ ] Invoke `handler('packages/app one', ctx)`. Assert that the resolver first anchors at `/remote/project`, passes the target as shell data rather than executable syntax, changes directory, and prints the resulting cwd.
- [ ] Complete the resolver child with `/remote/project/packages/app one\n` and exit status 0.
- [ ] Start a later `user_bash` operation; assert that it uses `/remote/project/packages/app one`.
- [ ] Keep the first `user_bash` promise pending on child 0. Invoke the cwd handler, then write the canonical path to resolver child 1 and emit `close(0)` before awaiting the handler. Finally emit `close(0)` on child 0 and await the old operation; this proves that the test leaves no pending child or promise.
- [ ] Start a later `user_bash` operation on child 2, assert its command uses the new cwd, emit `close(0)`, and await it.
- [ ] Execute the registered `bash` tool on child 3, assert its command maps the local tool cwd to the new remote cwd, emit `close(0)`, and await it. This is the representative registered-tool boundary; all registered remote tools obtain operations from the same shared context at execution time.
- [ ] Invoke `before_agent_start`; assert that the appended SSH context contains the new cwd.
- [ ] Instantiate the registered remote autocomplete provider with a no-result delegate. Start `getSuggestions(['@'], 0, 1, { signal })`, inspect child 4 and assert that both `fd` passes use the new cwd as `--base-directory`. Write `1 src\n` to stdout, emit `close(0)`, await the promise, and assert the returned `@src/` item. Do not leave its promise pending.
- [ ] Assert that the latest `ssh` status contains the remote host and new cwd, and that one info notification confirms the switch.
- [ ] **Green:** Add a safe remote cwd resolver. Anchor relative targets at the current remote cwd, pass both current cwd and target as quoted Bash positional arguments, run `cd --` and `pwd`, and clean CR/LF from the result.
- [ ] Mutate `sshContext.remoteCwd` only after the resolver exits successfully and returns a nonempty absolute path.
- [ ] Before mutation, verify that the context is still the active `resolvedSsh`; if a reconnect replaced it while the command was in flight, leave the new connection untouched and report that the switch was superseded.
- [ ] Refresh `ctx.ui.setStatus('ssh', ...)` with the existing status format and show a concise success notification.
- [ ] Do not re-register tools or the autocomplete provider after a cwd-only change. Their existing invocation-time reads must observe the mutated shared context.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`.
- Expected: the handler has no switching implementation, so no resolver child starts and later consumers still use `/remote/project`.
- Run (green): `mise run test --package packages/pi-remote`.
- Expected: all package tests pass; the old in-flight command keeps the old cwd and every later observed consumer uses the new cwd.

### Task 5: Support absolute paths, `~`, and failed switches

**Seam:** `ssh:cwd.handler(args, ctx)`

**Outcome:** Manual arguments accept relative paths, absolute paths, `~`, and `~/...`; invalid or unreachable targets leave the active cwd unchanged and report the remote failure.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`

**Steps:**

- [ ] **Red:** Add one table-driven public-handler test named `resolves supported cwd arguments without shell interpolation` with literal cases for `/srv/app`, `~`, and `~/src/app`.
- [ ] For each case, assert that the raw target appears only as a positional argument in the quoted remote command. Include shell metacharacters in one path fixture and assert that they are not evaluated.
- [ ] Return a canonical absolute `pwd` result for each case and assert that the latest status uses it.
- [ ] Add a failed-switch sub-scenario: return nonzero status with `No such file or directory`; assert one error notification, no success notification, and that later `user_bash` still uses the last successful cwd.
- [ ] **Green:** In the remote resolver, explicitly translate exact `~` to remote `$HOME` and a leading `~/` to a path under remote `$HOME` before `cd`. Do not rely on tilde expansion inside quotes.
- [ ] Preserve absolute targets and resolve relative targets from the current remote cwd.
- [ ] Reuse `formatSshFailureReason()` for a clean error notification such as `Cannot change remote cwd: <reason>`.
- [ ] Treat empty `pwd` output as failure. Never update status or shared cwd on any failure.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`.
- Expected: at least the `~` cases or failure-preserves-state case fails because Task 4 only supports the first relative-path slice.
- Run (green): `mise run test --package packages/pi-remote`.
- Expected: all package tests pass; supported argument forms resolve safely and failed switches preserve state.

### Task 6: Add the no-argument picker and document the command

**Seam:** `ssh:cwd.handler('', ctx)`

**Outcome:** `/ssh:cwd` opens a directory picker rooted at the current remote cwd, cancellation is a no-op, and the README contains complete usage and dependency behavior.

**Files:**

- Modify: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/src/index.ts`
- Modify: `packages/pi-remote/README.md`

**Steps:**

- [ ] **Red:** Extend the fake UI with a recorded `select(title, items)` method and a queued selection result. Add one test named `opens a cwd picker when no argument is provided`.
- [ ] Connect at `/remote/project`, invoke `handler('', ctx)`, and feed directory listing output.
- [ ] Assert that `select` is called even when there is only one non-parent directory. The title must include `/remote/project`; pass `autocompleteItems.map((item) => item.value)` to `select`, so its `string[]` uses the same values and order as argument completion and includes `..`.
- [ ] Queue a selected directory string, complete its resolver child with a canonical absolute path, and assert the cwd switch and success notification.
- [ ] Add a cancellation sub-scenario where `select` returns `undefined`; assert that no resolver child starts and state is unchanged.
- [ ] **Green:** Reuse the same listing and item-generation path as `getArgumentCompletions('')`. Do not create separate picker-only filtering rules.
- [ ] Always call `ctx.ui.select` for the no-argument connected flow. Do not auto-select a sole result.
- [ ] On listing failure, notify the user that remote directories could not be listed and leave cwd unchanged. A manual `/ssh:cwd <path>` must remain usable.
- [ ] **Green:** Add a `Remote working directory (/ssh:cwd)` section to `packages/pi-remote/README.md` with examples for no argument, relative path, absolute path, and `~`.
- [ ] Document that candidates search descendants of the current remote cwd, always include `..`, include hidden directories, follow symlinks, exclude `.git`, and return at most 100 picker/completion items total (`..` plus at most 99 descendants).
- [ ] Document that remote `fd` is preferred and standard `find` is the automatic fallback. Update the Requirements section so `fd` is required only for remote `@` completion, not for `/ssh:cwd`.
- [ ] Document that the switch affects all later SSH-backed tools, `!` commands, remote `@` completion, status, and prompt context; already-started operations retain their original cwd.
- [ ] Document that the switch lasts only for the active connection and that a failed switch leaves the prior cwd active.

**Validation:**

- Run (red): `mise run test --package packages/pi-remote`.
- Expected: the test fails because the no-argument handler does not open a picker.
- Run (green): `mise run test --package packages/pi-remote`.
- Expected: all package tests pass; selection switches cwd and cancellation has no side effects.
- Inspect: `packages/pi-remote/README.md`.
- Expected: every confirmed behavior above is explicit and no text says that `fd` is mandatory for `/ssh:cwd`.

## Final Validation

Run from the repository worktree root in this order:

- Run: `mise run test --package packages/pi-remote`.
- Expected: all `pi-remote` tests pass, including every new `/ssh:cwd` public-seam scenario.
- Run: `mise run typecheck --package packages/pi-remote`.
- Expected: TypeScript reports no errors for async command completions, fake UI additions, or mutable cwd state.
- Run: `mise run build --package packages/pi-remote`.
- Expected: Bun produces the package bundle successfully.
- Run: `hk check`.
- Expected: repo-wide ESLint and Prettier checks pass without modifying files.
- Run: `git status --short`.
- Expected: only the planned `src/index.ts`, `tests/index.test.ts`, `README.md`, and implementation-plan file are modified for this feature.

If a command fails because of an unrelated baseline issue, record the exact command and output. Do not modify another package.

## Failure Behavior

- No active SSH connection — completion returns `null`; command execution reports `No active SSH connection. Use /ssh first.`
- Remote `fd` is absent — directory listing uses remote `find` automatically.
- Both listing paths fail — inline completion returns no popup; the no-argument picker flow shows an error; manual path switching remains available.
- The user cancels the picker — no cwd resolution or state update occurs.
- The target does not exist, is not a directory, or is not accessible — show the cleaned remote error and retain the prior cwd and status.
- The resolver returns an empty path — treat it as failure and retain prior state.
- A reconnect replaces the active SSH context during resolution — do not mutate the replacement context; report that the cwd switch was superseded.
- An operation started before the switch — it completes or fails with the cwd captured at its start. Do not cancel or replay it.

## Privacy and Security

- Treat every remote cwd and candidate as untrusted data. Pass paths as quoted positional Bash arguments; never interpolate them as executable shell syntax.
- Do not log directory listings, SSH configuration, credentials, environment contents, or remote file contents.
- Keep existing `BatchMode=yes`, host-key handling, connection ownership, and control-path security unchanged.
- Directory names appear in the interactive completion or picker only after the user explicitly invokes `/ssh:cwd` or types its argument.

## Rollout Notes

- No migration, configuration, or new package dependency is required.
- Existing SSH connections gain the command immediately after the extension update.
- The change does not alter `/ssh`, `--ssh`, reconnect ownership, or shutdown behavior.

## Risks and Mitigations

- **Large directory trees:** Recursive discovery can be expensive. — Keep remote output at 100 paths and final UI output at 100 items. `fd` stops at its limit; the portable `find`/`awk` fallback can still traverse beyond 100 to preserve error detection, so recommend `fd` for large trees and reuse OpenSSH multiplexing.
- **Stale async completion:** `getArgumentCompletions` has no `AbortSignal`. — Keep each remote command bounded to 100 results and return only the current invocation's promise result.
- **Shell injection through a path:** Remote paths can contain spaces and metacharacters. — Pass current cwd and target as positional arguments and quote every generated command argument.
- **`find` portability:** Implementations differ in optional flags. — Use standard traversal and pruning constructs; keep fuzzy filtering in TypeScript.
- **Symlink loops:** Both `fd --follow` and `find -L` can encounter cycles. — Depend on each tool's cycle detection and keep the result cap.
- **Split cwd state:** Updating only the status or one tool would create inconsistent behavior. — Mutate the one shared context object and test representative public consumers after the switch.
- **Reconnect race:** A slow resolver could finish after `/ssh` replaces the connection. — Compare context identity before mutation and refuse to update stale state.

## Out of Scope

- Persisting cwd across SSH reconnects, Pi sessions, or process restarts.
- Searching the remote home directory or filesystem root independently of the current cwd.
- Installing or downloading `fd` on the remote host.
- Changing the remote cwd from the model through a new tool.
- Caching directory candidates across requests.
- Supporting newline characters in remote directory names.
- Changing remote `@` autocomplete semantics or its separate `fd` requirement.
- Cancelling, restarting, or replaying operations that were already running during a cwd switch.
- Refactoring unrelated SSH, grep, find-tool, or connection lifecycle code.

## Open Questions

**Open Questions:** None.
