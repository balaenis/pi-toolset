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
      "startupMode": "auto",
    },
  },
}
```

A different server name does **not** inherit recipe defaults, so supply all
required fields. Either `extensionToLanguage` or `extensions` must be present;
`extensionToLanguage` takes precedence.

## Override a built-in recipe

Share the recipe name to inherit its `extensionToLanguage`, `args`, `role`,
`startupMode`, and other defaults, then replace only the fields you want:

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
      "startupMode": "auto",
    },
  },
}
```

Using the recipe name `eslint` inherits the built-in ESLint defaults
(`validate: "on"`, `useFlatConfig: true`, `workingDirectory: { mode: "location" }`)
required for pull diagnostics. With a different server name, supply your own
`settings` block.

## Enable a manual server (Tailwind)

Manual servers stay dormant until you enable them for the current session - the
recommended default for broad companions like Tailwind CSS:

```jsonc
{
  "servers": {
    "tailwindcss": {
      "command": "tailwindcss-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
      },
      "role": "companion",
      "startupMode": "manual",
    },
  },
}
```

Then enable it for the session via `/lsp start` (an interactive panel; space to
toggle, esc to close). Manual servers are only enrolled into routing after you
start them. Use `/lsp status` to see each server's `startup` mode and
`manual active` flag. Requires TUI mode.

## Inspect diagnostics

Run `/lsp diagnostics` to see every diagnostic currently tracked by the
extension. It shows pending diagnostics (waiting to be delivered to the LLM) and
delivered diagnostics (already injected and tracked for cross-turn dedup),
grouped by file and tagged with severity, line/column, message, code, source,
and originating server.

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
