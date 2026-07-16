# Explanation

Why `@balaenis/pi-lsp` is designed the way it is. For configuration recipes see
[How-to guides](./how-to.md); for field tables see [Reference](./reference.md).

## Multi-server routing

Each file may be served by one primary server plus zero or more companion
servers.

- **Primary server** (`role: "primary"`, the default) - the single server
  consulted for the `lsp` tool's navigation operations (definitions, references,
  hover, symbols, call hierarchy). When two primary servers cover the same
  extension, the first one registered wins; configure `conflictGroup` only to
  make a replacement explicit.
- **Companion server** (`role: "companion"`) - receives `textDocument/didOpen`,
  `didChange`, `didSave`, and `didClose` notifications for files it covers and
  publishes diagnostics. Companions do not participate in navigation requests,
  so adding ESLint or Tailwind never overrides TypeScript's go-to-definition.

Passive diagnostics from every configured server (primary + companions) are
collected and tagged by source server, so TypeScript, ESLint, and Tailwind
diagnostics can coexist for the same file without overwriting each other.
Stopping a server via `/lsp start` doesn't permanently disable it; it may restart
on the next matching file event.

## Startup failure classification

Startup failures are split into permanent and retryable.

**Permanent failures** are not retried automatically because they require a
configuration or environment fix:

- missing executable or invalid command/workspace path (`ENOENT`, `ENOTDIR`,
  `EISDIR`, `ENAMETOOLONG`)
- executable permission or format errors (`EACCES`, `EPERM`, `ENOEXEC`)
- clearly invalid CLI arguments, such as unknown options or missing option values
- clearly invalid initialization/configuration text from the server, such as
  invalid `initializationOptions`, unsupported transport, or failed config parsing

**Retryable failures** are tried again on the next LSP use until the startup
attempt limit is reached:

- initialization timeout (`startupTimeout`, default `30000` ms)
- early JSON-RPC connection close without a permanent error pattern
- early non-zero process exit without a permanent stderr pattern
- unknown initialization errors

`maxRestarts` also caps retryable startup attempts. With the default
`maxRestarts: 3`, Pi makes at most three startup attempts for an
unknown/retryable failure, then leaves the server blocked with a retry-limit
message.

## Diagnostics: push vs pull

Diagnostics come from two sources:

- **Push servers** send `textDocument/publishDiagnostics` notifications
  unprompted.
- **Pull servers** are queried with `textDocument/diagnostic` requests fired
  after file sync when the server advertises `diagnosticProvider`.

Passive diagnostics are collected from every configured server covering the file
(primary + companions), so lint/type/etc. issues from different servers can
coexist. Diagnostics are deduplicated across turns after they are delivered to
the LLM.

## Autodetection merge precedence

User entries in `servers` are authoritative. The rules:

- A built-in recipe is skipped when its extensions are already covered by an
  enabled user `primary` entry.
- Companion (`role: "companion"`) user entries do **not** suppress a primary
  recipe, so you can layer ESLint alongside the built-in TypeScript recipe
  without losing navigation. Recipes still supplement uncovered languages.
- Invalid user entries do not disable autodetection for unrelated languages.
- When a user entry shares a built-in recipe name, it is merged on top at the
  field level (override just `command`, `args`, `env`, `settings`, etc. while
  keeping the recipe's `extensionToLanguage`, `role`). Merge precedence is
  **project config > global config > recipe defaults**.

## Zero-config design

With no `servers` block, the extension scans `PATH` for built-in recipes and
enables each one whose command is found. This lets a fresh install work
immediately for common languages without configuration. When the agent edits a
file or invokes the `lsp` tool for an extension covered by a recipe but the
matching binary is missing on `PATH`, the extension surfaces a single
non-blocking warning (`ctx.ui.notify(…, "warning")`) with an actionable install
hint and includes the same hint in the tool's text output. Notifications are
deduplicated per session by extension and reason.

## Windows `.cmd` shim handling

npm/pnpm/yarn install CLIs as `.cmd`/`.bat` shims that Node's `spawn()` cannot
launch directly. When the resolved command is a batch file, pi-lsp automatically
routes it through `cmd.exe` (`shell: true`) and folds the args into a single
quoted command string, so commands like `typescript-language-server` work
without extra configuration. Native `.exe` servers (e.g. `rust-analyzer`) keep
the direct spawn.
