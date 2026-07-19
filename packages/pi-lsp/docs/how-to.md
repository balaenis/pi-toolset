# How-to guides

Practical recipes for configuring and inspecting LSP servers. Each guide assumes
you have [built and loaded the extension](./tutorials.md#1-build-and-load-the-extension).

Configuration lives in a dedicated config file (separate from Pi's shared
`settings.json`, to avoid key collisions). The extension reads two files;
project overrides global:

1. `~/.pi/agent/@balaenis/pi-lsp/config.json` (global)
2. `<project>/.pi/@balaenis/pi-lsp/config.json` (per-project; resolved using the
   session's working directory)

Both use JSONC syntax (comments allowed).

## Configure a custom LSP server

```jsonc
{
  "servers": {
    "vtsls": {
      "command": "vtsls",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".js": "javascript",
        ".jsx": "javascriptreact",
      },
      "role": "primary",
    },
  },
}
```

A different server name does **not** inherit recipe defaults, so supply all
required fields. Either `extensionToLanguage` or `extensions` must be present;
`extensionToLanguage` takes precedence.

## Override a built-in recipe

Share the recipe name to inherit its `extensionToLanguage`, `args`, `role`, and
other defaults, then replace only the fields you want:

```jsonc
{
  "servers": {
    "typescript": {
      "command": "/home/user/.local/bin/typescript-language-server",
    },
  },
}
```

Merge precedence is **project config > global config > recipe defaults**.

## Disable a built-in recipe

```jsonc
{
  "servers": {
    "typescript": { "enabled": false },
  },
}
```

The built-in TypeScript recipe will not load, and no TypeScript server will
participate in routing or diagnostics.

## Add a companion server (ESLint alongside TypeScript)

Companions receive file notifications and publish diagnostics but do not
participate in navigation, so ESLint never overrides TypeScript's
go-to-definition:

```jsonc
{
  "servers": {
    "eslint": {
      "command": "vscode-eslint-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
      },
      "role": "companion",
    },
  },
}
```

Using the recipe name `eslint` inherits the built-in ESLint defaults
(`validate: "on"`, `useFlatConfig: true`, `workingDirectory: { mode: "location" }`)
required for pull diagnostics. With a different server name, supply your own
`settings` block.

## Use the built-in Tailwind CSS server

Install the server and ensure its command is on `PATH`:

```sh
npm install -g @tailwindcss/language-server
```

The built-in `tailwindcss` recipe is a companion with `enabled: false` by default,
so a global install does not activate in every project. Enable it for a project
with `/lsp config project` (space to toggle) or by writing:

```jsonc
{
  "servers": {
    "tailwindcss": { "enabled": true },
  },
}
```

Reload the Pi session after changing config. Once enabled, Tailwind receives file
notifications for covered extensions and publishes diagnostics alongside the
primary language server.

## Toggle built-in and configured servers

Use `/lsp config project` or `/lsp config global` (TUI only) to list built-in
recipes plus that scope's user servers. Same-named scope entries override built-in
defaults. Space toggles `enabled` and writes it to the corresponding
`config.json`. Reload the session for the change to take effect.

## Inspect diagnostics

Run `/lsp diagnostics` to see every diagnostic currently tracked by the
extension. It shows:

- **Pending** — waiting for the next user-initiated agent run; drained once via
  `before_agent_start` into one hidden durable message (not mid-run steering).
- **Delivered** — already persisted in session history and retained for
  cross-turn deduplication until the originating server reports the diagnostic
  clean or diagnostic state is reset.

Entries are grouped by file and tagged with severity, line/column, message,
code, source, and originating server.

## Set a custom workspace root or environment

```jsonc
{
  "servers": {
    "typescript": {
      "workspaceFolder": "/path/to/root",
      "env": { "PATH": "/custom/bin:${PATH}" },
      "initializationOptions": {},
      "settings": {},
    },
  },
}
```

`workspaceFolder` overrides the workspace root sent to the server (defaults to
the session cwd). `$VAR` and `${VAR}` in `env` are expanded from `process.env`.

## Auto-restart on crash

```jsonc
{
  "servers": {
    "rust-analyzer": { "restartOnCrash": true, "maxRestarts": 3 },
  },
}
```

`restartOnCrash` auto-restarts the server when it crashes unexpectedly, bounded
by `maxRestarts` (which also caps retryable startup attempts).

## Configure logging

Logging defaults to **error level**. Set `PI_LSP_LOG_LEVEL=debug` for verbose
output. Logs stream to `~/.pi/@balaenis/pi-lsp/default.log` (never to
stdout/stderr); override the destination with
`PI_LSP_LOG_FILE=/absolute/path/to/file`. If the file cannot be written, logging
is silently disabled for the rest of the session.
