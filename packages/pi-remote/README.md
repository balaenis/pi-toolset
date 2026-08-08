# @myagent/ssh-remote

Pi extension that delegates tool operations to a remote machine via SSH.

When `--ssh` is provided, the `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools run on the remote host instead of locally. Without the flag, all tools behave as usual, so the extension is safe to always load.

## Requirements

- SSH key-based auth to the remote host (no password prompts)
- `bash` on the remote
- `rg` (ripgrep) on the remote (for the `grep` and `find` tools)
- `fd` on the remote (for interactive `@` file completion; same tool local Pi uses)
- `file` on the remote (only for image mime-type detection; degrades gracefully)

## Usage

```bash
# Run in the current project with SSH enabled
pi -e ./src/index.ts --ssh user@host

# Target a specific remote directory (paths are remapped from local cwd)
pi -e ./src/index.ts --ssh user@host:/remote/path
```

Without a path, the remote working directory is resolved via `pwd` over SSH.

## How it works

- Path remapping: local absolute paths are rewritten from the local cwd to the remote cwd.
- `bash` runs as `cd <remote-cwd> && <command>` on the remote; timeout and abort signals are forwarded to the SSH child process.
- `grep` runs `rg` over SSH with `--json`, streaming matches and context lines; limits, line truncation, and notices mirror the built-in grep tool.
- `find` delegates to remote `rg --files` via the tool's `FindOperations` (globs match like fd `--full-path`); relative paths are produced by running inside the remote cwd.
- `ls` delegates to the tool's `LsOperations`: remote `test` stats and `ls -1A` directory listings.
- `ls` and `find` treat only a remote `test -e` exit status of `1` as a missing path and report `Path not found`. Every other SSH failure (any other nonzero status) and every local process error propagates unchanged from the registered tool; no exit status is classified as a transport failure.
- `!commands` (user bash) also execute remotely when SSH mode is active.
- When `--ssh` is given but the remote cannot be reached (e.g. `pwd` resolution fails), SSH mode fails loudly: a session-start notification and error status are shown, and every remote tool call errors with `SSH mode unavailable` instead of silently running on the local machine.
- The system prompt's `Current working directory:` line is rewritten to the remote cwd (format-tolerant: any cwd line is replaced, or one is appended).
- The TUI status bar shows the active SSH target via `ctx.ui.setStatus`.

## Connection multiplexing

SSH connections are reused automatically; no new flag is required. Each session owns one OpenSSH multiplexed connection created with `ControlMaster=auto` and a fixed `ControlPersist=10m`. The control socket is stored in a process- and session-unique private directory under the XDG runtime directory (when safe) or a private temporary subdirectory, so parallel Pi sessions never collide.

- Every normal SSH child runs with fixed internal bounds: `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `ConnectTimeout=15`, and `ConnectionAttempts=2`. These values bound failure detection and connection attempts; they are not user configuration.
- A failed in-flight operation is never automatically replayed. A later invocation starts another SSH attempt on the same session-owned connection and control path: `ControlMaster=auto` reuses a live master or opens a new transport. This is a new attempt, not a retry of the failed command.
- `bash`, `write`, and `edit` can have partial or uncertain remote side effects after a failure. Inspect the remote state before manually repeating them.
- `session_shutdown` sends a best-effort `ssh -O exit` to the master. The finite 10-minute persist bounds a master left by a hard Pi crash; such a crash can also leave an inert private directory for normal runtime/temp cleanup.
- Explicit-path startup stays lazy. The first tool call pays the connection handshake; pathless startup pays it during remote `pwd` resolution.
- Abort and timeout still kill the current SSH client/channel. The multiplexing master remains available for later commands.

## Remote `@` autocomplete

When SSH mode is active, the interactive editor's `@` completion lists remote files under the remote working directory instead of local project files. Selected items insert `@path` text only (no file-body injection), matching local Pi behavior — the model can use the `read` tool for contents.

- Typing `@` or `@query` fuzzy-searches under the remote cwd; `@dir/` searches inside that directory; `@dir/query` combines both. Absolute prefixes map from the local cwd to the remote cwd (`@/home/u/proj/src/` → `@/root/proj/src/`); pure remote-absolute prefixes (`@/etc/`) pass through.
- Directory candidates end with `/` so you can drill down (`@src/` → children). Results are capped at 20, and the listing honors the editor's abort signal (each keystroke cancels the in-flight SSH `fd`).
- Remote listing uses `fd` over SSH (aligned with local pi-tui `@` completion): `--type d` + `--type f`, `--hidden`, `--follow`, `.git` excludes, optional `--full-path` + path query, `--max-results 100`. Fuzzy/path matching is done by `fd` on the remote; the client re-scores and keeps the top 20.
- Errors, timeouts, and empty directories return an empty popup — never an error into the editor.
- Scope v1: only unquoted `@` tokens are remote. Slash commands (`/…`), bare path Tab completion, and quoted `@"…` tokens keep the local provider.
- The provider is registered only when SSH resolves successfully in `session_start`; without `--ssh` (or on failure) local `@` completion is untouched.
- Latency note: each keystroke on `@` still starts one remote listing command (two `fd` passes: dirs then files), but after the first command it reuses the authenticated multiplexed transport instead of performing a new SSH handshake.

## Install

```bash
pi install ./packages/ssh-remote
```

The extension is based on the official Pi example [`examples/extensions/ssh.ts`](https://github.com/earendil-works/pi-coding-agent/blob/main/examples/extensions/ssh.ts).
