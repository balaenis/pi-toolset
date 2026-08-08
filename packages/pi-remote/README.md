# @balaenis/pi-remote

Pi extension that delegates tool operations to a remote machine via SSH.

When `--ssh` is provided, the `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools run on the remote host instead of locally. Without the flag, all tools behave as usual, so the extension is safe to always load.

## Requirements

- SSH key-based auth to the remote host (password and interactive prompts are rejected immediately via `BatchMode=yes` — they would freeze the TUI)
- Unknown host keys are accepted on first connect (`StrictHostKeyChecking=accept-new`); changed keys still fail
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

## Interactive connection (`/ssh`)

While running in the TUI, connect at any time with the `/ssh` command:

```
/ssh                          # pick a host from ~/.ssh/config
/ssh user@host                # manual target
/ssh user@host:/remote/path   # manual target with a remote path
/ssh user@host -p 2222        # manual target with a custom port
```

- With no arguments, the hosts listed in `~/.ssh/config` are offered for selection. A single host connects directly; multiple hosts open a picker; no hosts shows a warning.
- Manual targets accept an optional `:/path` suffix and `-p PORT` (also `-pPORT`, `-p=PORT`, or `--port PORT`).
- Reconnecting switches the active connection; a failed reconnect keeps the previous working connection and shows the failure reason as an error notification.
- The same SSH-backed tools, `@` autocomplete, `!commands`, and status indicator are wired as for `--ssh`.

## How it works

- Path remapping: local absolute paths are rewritten from the local cwd to the remote cwd.
- `bash` runs as `cd <remote-cwd> && <command>` on the remote; timeout and abort signals are forwarded to the SSH child process.
- `grep` runs `rg` over SSH with `--json`, streaming matches and context lines; limits, line truncation, and notices mirror the built-in grep tool.
- `find` delegates to remote `rg --files` via the tool's `FindOperations` (globs match like fd `--full-path`); relative paths are produced by running inside the remote cwd.
- `ls` delegates to the tool's `LsOperations`: remote `test` stats and `ls -1A` directory listings.
- `ls` and `find` treat only a remote `test -e` exit status of `1` as a missing path and report `Path not found`. Every other SSH failure (any other nonzero status) and every local process error propagates unchanged from the registered tool; no exit status is classified as a transport failure.
- `!commands` (user bash) also execute remotely when SSH mode is active.
- When `--ssh` or `/ssh` cannot reach the remote (auth, host key, network, etc.), SSH mode fails loudly: an error notification shows the cleaned SSH reason (stderr), the status bar marks the failure, and every remote tool call errors with `SSH mode unavailable` instead of hanging on interactive prompts or silently running locally.
- The system prompt's `Current working directory:` line is rewritten to the remote cwd (format-tolerant: any cwd line is replaced, or one is appended).
- The TUI status bar shows the active SSH target via `ctx.ui.setStatus`.

## Connection multiplexing

SSH connections are reused automatically; no new flag is required. Each session owns one OpenSSH multiplexed connection created with `ControlMaster=auto` and a fixed `ControlPersist=10m`. The control socket is stored in a process- and session-unique private directory under the XDG runtime directory (when safe) or a private temporary subdirectory, so parallel Pi sessions never collide.

- Every normal SSH child runs in a separate process session with fixed internal bounds: `ServerAliveInterval=15`, `ServerAliveCountMax=3`, `ConnectTimeout=15`, `ConnectionAttempts=2`, `BatchMode=yes`, and `StrictHostKeyChecking=accept-new`. The separate session prevents `ProxyJump` and `ProxyCommand` children from opening Pi's controlling terminal. Failures return through stderr instead of showing interactive prompts.
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
pi install ./packages/pi-remote
```

The extension is based on the official Pi example [`examples/extensions/ssh.ts`](https://github.com/earendil-works/pi-coding-agent/blob/main/examples/extensions/ssh.ts).
