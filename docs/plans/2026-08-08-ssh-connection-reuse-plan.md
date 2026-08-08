# Implementation Plan

**Goal:** Reuse one OpenSSH multiplexed connection per active `pi-remote` session while preserving current remote-tool, abort, timeout, streaming, autocomplete, and failure behavior.

**Inputs:** User-provided SSH multiplexing handoff; `packages/pi-remote/src/index.ts`; `packages/pi-remote/src/remote-autocomplete.ts`; `packages/pi-remote/tests/remote-autocomplete.test.ts`; `packages/pi-remote/README.md`; `packages/pi-remote/package.json`; `packages/pi-remote/tsconfig.json`; repository `AGENTS.md`, `README.md`, `eslint.config.js`, `.gitignore`, and `.mise/tasks/{test,typecheck,build/_default}`; Pi 0.84.0 `docs/extensions.md` and `examples/extensions/ssh.ts`; OpenBSD [`ssh_config(5)`](https://man.openbsd.org/ssh_config); OpenSSH portable [`mux.c`](https://github.com/openssh/openssh-portable/blob/master/mux.c); Bun test CLI documentation from Context7 library `/oven-sh/bun`.

**Assumptions:**

- Use a fixed `ControlPersist=10m`. Do not add an environment variable or CLI flag.
- Do not warm the connection when `--ssh` includes an explicit remote path. The first remote operation creates the master, as current startup does not test that target.
- Use unit and extension-lifecycle tests with injected process boundaries. Do not add a local `sshd` integration harness. Use the documented manual SSH check for real transport validation.
- Support the repository's Linux and macOS targets. Use a conservative 100-byte ControlPath limit for Unix-domain socket portability.
- Keep the current `--ssh` parser and key-based authentication contract unchanged.
- Do not correct the stale README package heading or install path in this change. They are unrelated documentation cleanup.

**Architecture:** Add a session-scoped `SshConnection` in `src/ssh.ts`. It owns one private ControlPath, prepends multiplexing options to every SSH command, and performs idempotent best-effort master shutdown. Create it only in `session_start`, pass it to every remote operation, and close it in `session_shutdown`; no extension-factory work creates directories, sockets, processes, or timers.

**Tech Stack:** TypeScript, Node.js child processes and file-system APIs, OpenSSH multiplexing, Pi extension lifecycle hooks, Bun test runner, mise, ESLint and Prettier through hk.

---

## Scope

**In scope:** private ControlPath creation, centralized SSH spawning, `ControlMaster=auto`, fixed `ControlPersist=10m`, session startup and shutdown ownership, crash-bounded persistence, focused unit and lifecycle tests, package README behavior documentation, and manual real-SSH validation.

**Out of scope:** connection reuse across Pi processes or sessions, an SSH warm-up command for explicit paths, a configurable persist duration, a local `sshd` test fixture, changes to remote command construction, changes to `@` completion scoring, `--ssh` parsing fixes such as IPv6 support, package renaming, and generated `dist/` changes.

A custom `isControlSocketError()` parser and client-side stale-socket retry are also out of scope. OpenSSH already treats an absent socket as no master and, with `ControlMaster=auto`, unlinks an `ECONNREFUSED` stale socket before it creates a new master. Existing stderr and exit-code handling must continue to report failures that OpenSSH cannot recover.

## File Map

- Create: `packages/pi-remote/src/ssh.ts` — create safe control paths, centralize all `ssh` process creation, expose `SshConnection`, and perform idempotent best-effort cleanup.
- Modify: `packages/pi-remote/src/index.ts` — replace remote strings at SSH execution boundaries with one session-scoped `SshConnection`; register startup and shutdown lifecycle ownership.
- Test: `packages/pi-remote/tests/ssh.test.ts` — cover safe path selection, multiplexed argv construction, connection reuse, closed-state behavior, and cleanup through exported SSH interfaces.
- Test: `packages/pi-remote/tests/index.test.ts` — cover extension startup, explicit-path lazy connection use, shutdown, and loud startup failure through registered Pi handlers.
- Modify: `packages/pi-remote/README.md` — document automatic multiplexing, lifecycle, fixed persistence, abort behavior, and the revised autocomplete latency statement.
- Unchanged: `packages/pi-remote/src/remote-autocomplete.ts` and `packages/pi-remote/tests/remote-autocomplete.test.ts` — keep pure completion behavior unchanged and use the existing suite as regression coverage.
- Unchanged: `packages/pi-remote/package.json` — add no dependency, script, export, flag, or version change.

All new TypeScript files must start with the repository-required two-line `ABOUTME:` header. Keep comments minimal. Do not write `packages/pi-remote/dist/`; the shared build task generates it and Git ignores it.

## Seams

These seams follow the user-requested SSH module and lifecycle coverage. Do not add tests at a different seam without confirmation.

- **Seam:** `createSshControlPath(remote, dependencies?)` from `packages/pi-remote/src/ssh.ts` — verifies private directory selection, target-safe naming, path-length enforcement, fallback, and cleanup on path-construction failure.
- **Seam:** `createSshConnection(remote, dependencies?)` and `SshConnection.spawn(command)` — verifies that no command starts during construction and that every command uses the same multiplexing options and ControlPath.
- **Seam:** `SshConnection.close()` — verifies one best-effort `ssh -O exit`, idempotence, closed-state rejection, and local socket-directory removal.
- **Seam:** named `registerPiRemote(pi, dependencies)` plus the unchanged default extension export — verifies that Pi lifecycle hooks own the connection and that production registration still uses the real SSH factory.
- **Seam:** registered tool and event behavior through a minimal fake `ExtensionAPI` — verifies loud SSH startup failure and prevents silent local fallback without testing private helper calls.

## Tasks

### Task 1: Create a private bounded ControlPath

**Seam:** `createSshControlPath(remote, dependencies?)`

**Outcome:** The package can allocate a process/session-unique control socket path in a mode-`0700` directory, under a conservative 100-byte limit, without starting SSH.

**Files:**

- Create: `packages/pi-remote/src/ssh.ts`
- Test: `packages/pi-remote/tests/ssh.test.ts`

**Steps:**

- [ ] **Red:** Create `tests/ssh.test.ts` with its two-line `ABOUTME:` header. Add `creates a private control path within the OpenSSH socket limit` using real temporary directories and fixed dependency values. Assert that the immediate socket parent has mode `0700`, the UTF-8 path is at most 100 bytes, the socket basename does not expose `user@host`, two allocations do not collide, the same target produces the same basename, and a different target produces a different basename. Add `afterEach` cleanup for every test-owned root.
- [ ] **Green:** Create `src/ssh.ts` with its two-line `ABOUTME:` header. Export `SshControlPath` as `{ directory: string; socketPath: string }`, `SshRuntimeDependencies`, and async `createSshControlPath(remote, dependencies?)`.
- [ ] Define `SshRuntimeDependencies` with optional `env?: NodeJS.ProcessEnv`, `processId?: number`, `getUid?: () => number | undefined`, and `temporaryDirectory?: string`. Default them to `process.env`, `process.pid`, `process.getuid?.()`, and `os.tmpdir()`. Let tests replace only these file-system and process-environment boundaries.
- [ ] Name the non-trivial values, including `CONTROL_PATH_MAX_BYTES = 100`, the private-directory prefix, and the target-hash length.
- [ ] Prefer `XDG_RUNTIME_DIR` only when it is absolute, exists as a directory, belongs to the current UID, and has no group/other write bits. Do not trust its name alone.
- [ ] Create a fresh directory with `mkdtemp()` using a short `pi-r-<pid>-` prefix. Apply mode `0700` explicitly.
- [ ] Build a short socket basename from a truncated SHA-256 digest of the exact remote target. The hash must hide the username and host while distinguishing targets; the random private parent provides per-session uniqueness.
- [ ] Enforce the limit with `Buffer.byteLength(socketPath)`, not JavaScript character count.

**Validation:**

- Run (red): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "creates a private control path within the OpenSSH socket limit"`
- Expected: the test fails because `../src/ssh.ts` and `createSshControlPath` do not exist.
- Run (green): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "creates a private control path within the OpenSSH socket limit"`
- Expected: one test passes; path creation performs only local file-system work and each returned path satisfies the independent 100-byte test constant.

### Task 2: Add safe runtime-directory fallback

**Seam:** `createSshControlPath(remote, dependencies?)`

**Outcome:** Invalid or overlong XDG paths fall back to a private directory under `os.tmpdir()`, and the function never returns an unsafe or overlong path.

**Files:**

- Modify: `packages/pi-remote/src/ssh.ts`
- Test: `packages/pi-remote/tests/ssh.test.ts`

**Steps:**

- [ ] **Red:** Add `falls back instead of returning an unsafe control path`. Use a group-writable or wrong-owner XDG candidate and a separate temporary fallback root. Assert that the returned socket is below the fallback root and its immediate parent is mode `0700`.
- [ ] Extend the same scenario with an overlong XDG candidate. Assert that its rejected private candidate is removed before the function returns the shorter fallback path.
- [ ] Within the same named test, add a no-viable-candidate case with overlong/unusable roots. Assert the exact error `Unable to create a safe SSH ControlPath within 100 bytes` and no private directory left by the failed attempt.
- [ ] **Green:** Iterate over at most two deduplicated bases: a validated XDG runtime directory, then `os.tmpdir()`.
- [ ] Treat the fallback parent as untrusted. Rely only on the newly created random child directory after forcing mode `0700`.
- [ ] If directory creation, permission setup, ownership validation, or byte-length validation fails, remove the candidate recursively with `force: true` before trying the next base.
- [ ] If no candidate works, throw `new Error('Unable to create a safe SSH ControlPath within 100 bytes')`. Do not start SSH.

**Validation:**

- Run (red): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "falls back instead of returning an unsafe control path"`
- Expected: the test fails because the first implementation does not reject/fallback for the unsafe or overlong candidate.
- Run (green): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "falls back instead of returning an unsafe control path"`
- Expected: the fallback and terminal-error cases pass, and rejected candidate directories do not remain.

### Task 3: Centralize multiplexed command spawning

**Seam:** `createSshConnection(remote, dependencies?)` and `SshConnection.spawn(command)`

**Outcome:** One connection object reuses one ControlPath and applies the required OpenSSH options to every current remote command shape.

**Files:**

- Modify: `packages/pi-remote/src/ssh.ts`
- Test: `packages/pi-remote/tests/ssh.test.ts`

**Steps:**

- [ ] **Red:** Add `adds multiplexing options and reuses one control path`. Inject a process spawner at the external child-process boundary. Assert that creating the connection starts no process, two `spawn()` calls use the same path, and both receive exactly this argument order before the unchanged remote command: `-o`, `ControlMaster=auto`, `-o`, `ControlPersist=10m`, `-o`, `ControlPath=<path>`, `<remote>`, `<command>`.
- [ ] Assert that command processes retain `stdio: ['ignore', 'pipe', 'pipe']`. This preserves the no-stdin/password-prompt contract and current stdout/stderr handling.
- [ ] **Green:** Add `spawnProcess?: typeof spawn` to `SshRuntimeDependencies`, default it to Node's real `spawn`, and add the named `CONTROL_PERSIST = '10m'` constant.
- [ ] Export `SshChildProcess` as `ChildProcessByStdio<null, Readable, Readable>`. Export async `createSshConnection(remote, dependencies?)` and `SshConnection` with readonly `remote`, readonly `controlPath`, and `spawn(command): SshChildProcess`.
- [ ] Use `createSshControlPath()` once during connection creation. Do not create or discover a new path per command.
- [ ] Add one internal `spawnSsh(args, stdio)` adapter. It must be the only code that calls the injected `spawnProcess('ssh', ...)` boundary. Use it for normal commands and later cleanup.
- [ ] Keep command strings opaque. Do not quote, parse, normalize, or alter remote scripts in this module.
- [ ] Put all three `-o` options before the destination so they override conflicting `~/.ssh/config` values while other user SSH settings, such as aliases, keys, ProxyJump, and ports, still apply.

**Validation:**

- Run (red): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "adds multiplexing options and reuses one control path"`
- Expected: the test fails because `createSshConnection` and multiplexed spawning do not exist.
- Run (green): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "adds multiplexing options and reuses one control path"`
- Expected: connection construction is process-free, and every command has the exact multiplexed argv and shared ControlPath.

### Task 4: Close the master idempotently

**Seam:** `SshConnection.close()`

**Outcome:** A used connection requests master termination once, always attempts local cleanup, and cannot start a new channel after shutdown begins.

**Files:**

- Modify: `packages/pi-remote/src/ssh.ts`
- Test: `packages/pi-remote/tests/ssh.test.ts`

**Steps:**

- [ ] **Red:** Add `closes the master and cleans resources once`. Spawn one normal command, call `close()` twice, and assert one cleanup invocation with `-o`, `ControlPath=<path>`, `-O`, `exit`, `<remote>` and ignored stdio.
- [ ] In the same public behavior test, make the cleanup subprocess return non-zero or emit `error`. Assert that both `close()` calls resolve, the private directory is removed, and a later `spawn()` throws `SSH connection is closed`.
- [ ] **Green:** Add `close(): Promise<void>` to `SshConnection`. Mark the connection closed synchronously and memoize the first close promise.
- [ ] Track whether any command was spawned. If not, skip `ssh -O exit` and remove the unused private directory directly.
- [ ] If a command was spawned, invoke `ssh -o ControlPath=<path> -O exit <remote>` through the central adapter. Wait for either `error` or `close`, and settle only once.
- [ ] Swallow cleanup subprocess errors and non-zero exits. In a `finally` path, remove the socket and its package-created private directory recursively with `force: true`.
- [ ] Do not remove a socket before sending `-O exit`; the master needs that socket to receive the terminate request.

**Validation:**

- Run (red): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "closes the master and cleans resources once"`
- Expected: the test fails because the connection has no `close()` contract or does not perform idempotent termination and cleanup.
- Run (green): `cd packages/pi-remote && bun test tests/ssh.test.ts -t "closes the master and cleans resources once"`
- Expected: repeated close is a no-op after the first request, cleanup failures do not reject, local resources disappear, and post-close spawn is rejected.

### Task 5: Route all remote operations through the session connection

**Seam:** `registerPiRemote(pi, dependencies)` and registered Pi lifecycle/event behavior

**Outcome:** The extension owns exactly one SSH connection per active SSH session, all remote operations use it, explicit-path startup stays lazy, and shutdown closes it once.

**Files:**

- Modify: `packages/pi-remote/src/index.ts`
- Test: `packages/pi-remote/tests/index.test.ts`
- Test: `packages/pi-remote/tests/remote-autocomplete.test.ts`

**Steps:**

- [ ] **Red:** Create `tests/index.test.ts` with its two-line `ABOUTME:` header. Add `defers SSH setup to the session lifecycle` with a minimal fake `ExtensionAPI`. Implement only `registerFlag`, `getFlag`, `registerTool`, and `on`, plus UI recorders for `notify`, `setStatus`, and `addAutocompleteProvider`. Capture flags, registered tools, and event handlers. Inject a fake `SshConnection` factory at the SSH system boundary.
- [ ] Assert that extension registration creates no connection. Invoke `session_start` with `user@host:/remote/path`; assert one connection is created then, no command is spawned for warm-up, remote autocomplete is registered, and the status identifies the same target and path.
- [ ] Invoke the registered `user_bash` handler and one successful operation against a child-process-compatible fake. Assert the existing remote `cd <remote-cwd> && <command>` shape and merged output behavior remain unchanged.
- [ ] Invoke `session_shutdown` twice. Assert `close()` runs once, resolved state is cleared before the awaited close, and a later `user_bash` event does not intercept local execution.
- [ ] **Green:** Import `createSshConnection` and `SshConnection` from `./ssh.ts`. Export `PiRemoteDependencies` with one field, `createSshConnection: typeof createSshConnection`. Export named `registerPiRemote(pi, dependencies)` for the lifecycle seam; keep the default export as a one-argument Pi factory that calls it with `{ createSshConnection }`.
- [ ] Change `sshExec`, `sshExecStream`, and `createRemoteBashOps.exec` to call `connection.spawn(command)`. Keep their data listeners, line parsing, abort listeners, timeout timer, `child.kill()`, close handling, return types, and error strings unchanged.
- [ ] Change `createRemoteReadOps`, `createRemoteWriteOps`, `createRemoteEditOps`, `createRemoteBashOps`, `createRemoteGrepExec`, `createRemoteLsOps`, `createSshRemoteFileLister`, and `createRemoteFindOps` to accept the same `SshConnection` instead of a remote string.
- [ ] Replace the `ChildProcess` value/type dependency in `index.ts` with the return type exposed by `SshConnection.spawn()`. After this task, `index.ts` must not import or call Node child-process APIs.
- [ ] Change resolved state to `{ connection: SshConnection; remoteCwd: string }`. Read display text from `connection.remote`.
- [ ] In `session_start`, read the flag first. If absent, create no path, directory, timer, socket, or child process. If present, create the connection. For a missing path, run the existing `pwd` through that connection; this first command may establish the master. For an explicit path, set state without a remote command.
- [ ] Register `session_shutdown` beside `session_start`. Capture the resolved connection, clear `resolvedSsh` before awaiting, clear session failure state, and call `close()` if a connection exists. Repeated shutdown handling must be a no-op.
- [ ] Keep tool factories per execution call. Only the transport object is session-scoped.
- [ ] Keep `user_bash`, `before_agent_start`, grep JSON streaming, find/lister `pipefail` scripts, match-limit kills, and autocomplete aborts unchanged apart from passing the connection object.

**Validation:**

- Run (red): `cd packages/pi-remote && bun test tests/index.test.ts -t "defers SSH setup to the session lifecycle"`
- Expected: the test fails because `registerPiRemote` and the injectable session connection seam do not exist.
- Run (green): `cd packages/pi-remote && bun test tests/index.test.ts -t "defers SSH setup to the session lifecycle"`
- Expected: registration is side-effect free, explicit-path startup performs no warm-up, remote user bash uses the session connection, and shutdown closes it once.
- Run: `rg -n "node:child_process|spawnProcess\\(" packages/pi-remote/src`
- Expected: every child-process import and process-spawner call is in `packages/pi-remote/src/ssh.ts`; `src/index.ts` has no match.
- Run: `cd packages/pi-remote && bun test tests/remote-autocomplete.test.ts`
- Expected: all existing remote autocomplete tests pass unchanged.

### Task 6: Preserve loud failure behavior and document reuse

**Seam:** registered tool behavior after a failed `session_start`

**Outcome:** Local ControlPath or remote `pwd` failure closes partial state, reports the original failure, never falls back to local tools, and the README explains automatic reuse and cleanup.

**Files:**

- Modify: `packages/pi-remote/src/index.ts`
- Test: `packages/pi-remote/tests/index.test.ts`
- Modify: `packages/pi-remote/README.md`

**Steps:**

- [ ] **Red:** Add `keeps failed SSH startup loud and closes its connection`. Configure `--ssh user@host` without a path. Make the injected connection's `pwd` client return SSH failure stderr and a non-zero exit.
- [ ] Assert that `session_start` closes the partial connection, records the original `SSH failed (<code>): <stderr>` message, emits the existing error notification/status, does not register remote autocomplete, and leaves no resolved connection.
- [ ] Invoke a registered remote-capable tool after startup returns. Assert it rejects with `SSH mode unavailable: <original message>` before local operations can run.
- [ ] **Green:** Wrap control-path creation and optional `pwd` resolution in one startup failure boundary. Retain a local connection reference until startup succeeds.
- [ ] On failure, set `resolvedSsh` to null, preserve the original message in `sshFailure`, publish the existing UI error immediately, and then await best-effort `connection?.close()`. Cleanup errors must never delay or replace the original failure report.
- [ ] Preserve explicit-path compatibility: do not test reachability during startup. If its first tool call fails, surface the normal SSH/process error and keep remote mode selected; never run the local tool.
- [ ] Add a `Connection multiplexing` section to `packages/pi-remote/README.md`. State that reuse is automatic, requires no new flag, uses `ControlMaster=auto` plus fixed `ControlPersist=10m`, and stores a process/session-unique socket in a private XDG runtime directory or private temporary subdirectory.
- [ ] State that `session_shutdown` sends best-effort `ssh -O exit`, while the finite persist duration bounds a master left by a hard Pi crash. Note that a crash can leave an inert private directory for normal runtime/temp cleanup.
- [ ] State that explicit-path startup remains lazy. The first tool call pays the connection handshake; pathless startup pays it during remote `pwd`.
- [ ] State that abort and timeout still kill the current SSH client/channel. The multiplexing master remains available for later commands.
- [ ] Update the remote `@` autocomplete latency note: each keystroke still starts one remote listing command, but after the first command it reuses the authenticated transport instead of performing a new SSH handshake.
- [ ] Do not document a persist configuration knob, because none is added. Do not change the stale package heading/install path in this scoped change.

**Validation:**

- Run (red): `cd packages/pi-remote && bun test tests/index.test.ts -t "keeps failed SSH startup loud and closes its connection"`
- Expected: the test fails because partial startup does not yet close the new connection or preserve all loud-failure assertions.
- Run (green): `cd packages/pi-remote && bun test tests/index.test.ts -t "keeps failed SSH startup loud and closes its connection"`
- Expected: partial state is closed, the original error remains visible, autocomplete stays unregistered, and tool execution cannot fall back locally.
- Run: `hk check`
- Expected: repository ESLint and Prettier checks pass with no `console` violations.
- Inspect: `packages/pi-remote/src/ssh.ts`, `packages/pi-remote/tests/ssh.test.ts`, and `packages/pi-remote/tests/index.test.ts`.
- Expected: each new TypeScript file starts with two `// ABOUTME:` lines.

## Final Validation

- Run: `mise run test --package packages/pi-remote`
- Expected: `tests/ssh.test.ts`, `tests/index.test.ts`, and the existing autocomplete suite pass with zero failures.
- Run: `mise run typecheck --package packages/pi-remote`
- Expected: `bunx tsgo -p tsconfig.json --noEmit` reports no TypeScript errors in `src` or `tests`.
- Run: `mise run build --package packages/pi-remote`
- Expected: the shared Bun build bundles `src/index.ts` and `src/ssh.ts` into `packages/pi-remote/dist/index.js`; no new runtime dependency or extra package entry is required.
- Run: `rg -n "node:child_process|spawnProcess\\(" packages/pi-remote/src`
- Expected: all matches are in `packages/pi-remote/src/ssh.ts` and none are in `packages/pi-remote/src/index.ts`.
- Run: `hk check`
- Expected: repository-wide ESLint and Prettier checks pass.

### Manual SSH validation

1. Run `mise run build --package packages/pi-remote`.
2. Start pathless mode with `pi -e ./packages/pi-remote/dist/index.js --ssh user@host`. Expected: startup resolves `pwd` and creates the master/socket.
3. In another terminal, locate the socket under the selected private runtime/temp directory. A starting command is `find "${XDG_RUNTIME_DIR:-/tmp}" "$(node -p 'require("node:os").tmpdir()')" -maxdepth 2 -type s -path '*/pi-r-*/*' -print 2>/dev/null`.
4. Set `CONTROL_PATH` to the returned socket and run `ssh -S "$CONTROL_PATH" -O check user@host`. Expected: OpenSSH prints `Master running (pid=...)`.
5. Run at least two remote operations, including one buffered operation such as `read` or `ls`, one streaming operation such as `grep` or `@` autocomplete, and one `!pwd`. Expected: all succeed through the same master; later operations do not perform a new authentication handshake.
6. Start a long `!sleep 30`, abort it, then run `ssh -S "$CONTROL_PATH" -O check user@host`. Expected: the command channel closes with the existing abort behavior and the master remains running.
7. Exit Pi normally. Run `ssh -S "$CONTROL_PATH" -O check user@host` and `test ! -e "$(dirname "$CONTROL_PATH")"`. Expected: the check fails because the master stopped, and the package-created private directory is gone.
8. Start `pi -e ./packages/pi-remote/dist/index.js --ssh user@host:/remote/path`. Before the first tool call, confirm no socket exists in its new private directory; after one tool call, confirm `-O check` succeeds. This verifies the no-warm-up decision.

## Failure Behavior

- **No `--ssh` flag:** create no SSH connection state or local ControlPath resources; all current local tools and completion behavior remain unchanged.
- **Unsafe, unwritable, or overlong ControlPath candidates:** remove any partial private directory and fail SSH startup loudly. Never continue with an unsafe path and never fall back to local tools.
- **Pathless startup cannot connect or run `pwd`:** retain the current notification/status and `SSH mode unavailable` tool error, close partial SSH state, and do not register remote autocomplete.
- **Explicit-path target is unreachable:** keep current lazy behavior. Startup can report active SSH mode, but the first remote operation returns its SSH error. It does not execute locally.
- **Absent or stale control socket:** let `ControlMaster=auto` fall back to a normal connection and become the new master. Do not add a second retry loop or suppress unrecoverable stderr.
- **Buffered SSH command exits non-zero:** keep `SSH failed (<code>): <stderr>`.
- **Streaming grep/find/list command exits:** keep each caller's current code and stderr interpretation, including grep exit code `1` and empty autocomplete fallback.
- **Abort or timeout:** call `child.kill()` on the current multiplexing client and preserve `aborted`, `Operation aborted`, and `timeout:<seconds>` behavior. Do not terminate the master from command cancellation.
- **Cleanup finds no master, exits non-zero, or cannot spawn `ssh`:** swallow the cleanup error, attempt local directory removal, and let session shutdown continue.
- **Pi crashes before `session_shutdown`:** the OpenSSH master can survive only until the fixed 10-minute idle period. A new Pi process uses a different private path, so it does not collide with the orphan.
- **Use after shutdown:** `SshConnection.spawn()` throws `SSH connection is closed`; old session code cannot recreate a master after cleanup starts.

## Privacy and Security

- The control socket grants access to an authenticated SSH master. Keep its immediate parent at mode `0700` and reject unsafe XDG runtime directories.
- Use a SHA-256-derived target token in the socket basename. Do not place raw usernames, hosts, remote paths, commands, keys, or credentials in the filesystem name.
- Keep the full ControlPath at or below 100 UTF-8 bytes to stay below known Linux and macOS Unix-domain socket limits.
- Pass ControlPath and OpenSSH options as argv elements. Do not interpolate them into a shell command.
- Continue to ignore SSH stdin. Do not introduce password collection, askpass integration, secret logging, or SSH configuration writes.
- Command-line ControlMaster, ControlPersist, and ControlPath values intentionally override the same user configuration keys for package-owned sessions. Other SSH configuration continues to apply.
- A hard crash can leave a socket or empty private directory until OpenSSH/runtime/temp cleanup. Process/session-unique paths prevent a later process from trusting that artifact.

## Rollout Notes

- Before implementation, run `git status --short --branch`. If the current checkout is still `main`, create the required isolated worktree with `git worktree add .worktrees/ssh-connection-reuse -b feat/ssh-connection-reuse` and execute all plan steps there. Do not stage or commit unless requested.
- The optimization is automatic for every existing `--ssh` user. No migration, new flag, environment variable, package dependency, or package version action is required in this implementation.
- The first SSH operation still pays the normal connection cost. Later buffered, streaming, bash, user-bash, find, grep, ls, read/write/edit, and autocomplete operations reuse the master.
- OpenSSH option support becomes an explicit runtime requirement. A non-OpenSSH-compatible `ssh` client that rejects `ControlMaster`, `ControlPersist`, ControlPath, or `-O exit` will fail loudly instead of using the optimization.
- Build output remains generated and ignored. The implementation changes source, tests, and README only.

## Risks and Mitigations

- **A runtime directory makes the socket path too long.** Use short names, enforce a conservative byte limit, try a private temporary fallback, and fail before SSH if no safe path exists.
- **A cleanup request fails or Pi is killed.** Make shutdown best-effort and idempotent; use finite `ControlPersist=10m` as the crash safety net.
- **Multiplexed cancellation differs from a fresh SSH process.** Keep the existing client `kill()` logic unchanged and manually verify that the remote channel closes while the master survives.
- **Unit tests cannot prove real OpenSSH reuse.** Test argv, path safety, and lifecycle deterministically; require `ssh -O check` in manual validation.
- **User SSH multiplexing settings conflict with package state.** Override only the three multiplexing keys and use a package-owned unique path; preserve all unrelated user SSH configuration.
- **Centralization accidentally changes command or output behavior.** Keep command strings and event handlers in `index.ts`, move only process creation/path ownership, run existing autocomplete tests, and manually cover buffered, streaming, and user-bash paths.

## Open Questions

**None for this implementation.** The decisions are fixed at 10-minute persistence, no explicit-path warm-up, unit/lifecycle automation plus manual real-SSH validation, and no custom stale-socket retry predicate.
