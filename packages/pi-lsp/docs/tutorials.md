# Tutorial: Get LSP intelligence in Pi

This tutorial gets you from a built extension to live code intelligence in a few
minutes. You will load the extension, rely on zero-config autodetection, query a
symbol, and inspect the runtime.

It assumes you are familiar with [Pi](https://github.com/earendil-works/pi) and
have the repo checked out locally.

## Prerequisites

- The `pi` CLI installed and on `PATH`.
- At least one language server on `PATH` for the languages you edit. The
  zero-config recipes cover TypeScript, ESLint, Python, Rust, Go, Kotlin, Lua,
  C/C++, Bash, JSON, YAML, HTML, CSS, and Vue (see
  [Reference: built-in recipes](./reference.md#built-in-recipes) for install
  hints).

## 1. Build and load the extension

The package is not published to a registry yet. Build it and load it with `-e`:

```sh
mise run build --package packages/pi-lsp
pi -e ./packages/pi-lsp/dist/index.js
```

Pi now has the `lsp` tool, the `/lsp` slash command, and a statusline indicator.

## 2. Let zero-config autodetection find your servers

With no `servers` block in your config, the extension scans `PATH` for built-in
recipes and enables each one whose command is found. If `typescript-language-server`
is on `PATH`, TypeScript support is already active - no configuration needed.

Open or edit a `.ts` file in your project. The matching server starts lazily on
first use.

## 3. Query a symbol with the `lsp` tool

Ask Pi to look something up, for example "go to the definition of `SessionManager`".
Pi calls the `lsp` tool with `goToDefinition`:

```json
{ "operation": "goToDefinition", "filePath": "src/session.ts", "line": 42, "character": 10 }
```

All operations require `filePath`, `line` (1-based), and `character` (1-based).
`documentSymbol` and `workspaceSymbol` accept them for schema compatibility but
do not send a position. When no server is configured for a file type or the
server is still starting, the tool returns a clear text message instead of an
error.

## 4. Watch the statusline

The footer shows a passive LSP health indicator reflecting live runtime state:

```
⚡LSP             - servers running, no diagnostics
⚡LSP …1          - one starting (dim)
⚡LSP ✕1          - one in error (red)
⚡LSP             - bolt is error-colored while diagnostics are present
(hidden)         - no servers starting/running/in error
```

The bolt uses the theme's `error` color whenever one or more diagnostics are
tracked; otherwise it keeps the accent color. `…n` counts starting servers and
`✕n` counts servers in error. The segment hides entirely when all counts are
zero.

## 5. Inspect the runtime

Run `/lsp status` to see the manager state, server counts by lifecycle state,
and per-server details (command, workspace, covered extensions, start time,
restart count, last error). It starts no stopped servers.

## Next steps

- [How-to guides](./how-to.md) for configuring custom servers, companions, manual
  servers, and diagnostics.
- [Reference](./reference.md) for the full config field table, recipes, and
  statusline states.
- [Explanation](./explanation.md) for multi-server routing, startup failure
  classification, and diagnostics push/pull.
