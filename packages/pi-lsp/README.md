# @balaenis/pi-lsp

Language Server Protocol support for [Pi](https://github.com/earendil-works/pi)'s coding agent. Provides code intelligence operations (go-to-definition, find-references, hover, document/workspace symbols, call hierarchy, go-to-implementation) via the `lsp` tool, passive diagnostics, a statusline health indicator, and `/lsp` slash commands.

## Features

- Nine `lsp` tool operations (definition, references, hover, symbols, call hierarchy, implementation)
- Passive diagnostics from every active server covering a file (primary + companions), push and pull
- Zero-config autodetection for 15 common language servers
- Multi-server routing: one primary for navigation, zero or more companions for diagnostics
- Built-in Tailwind CSS companion for class-name intelligence alongside primary servers
- Restart-on-crash with bounded retryable startup attempts
- Statusline health indicator and `/lsp status|diagnostics|start` commands
- Per-project JSONC config with field-level recipe merging

## Local development

The package is not published to a registry yet. Build it and load it with `-e`:

```sh
mise run build --package packages/pi-lsp
pi -e ./packages/pi-lsp/dist/index.js
```

## Documentation

- [Tutorial: Get LSP intelligence in Pi](./docs/tutorials.md) - load the extension, rely on autodetection, query a symbol
- [How-to guides](./docs/how-to.md) - configure custom servers, override/disable recipes, add companions, inspect diagnostics
- [Reference](./docs/reference.md) - `lsp` operations, config fields, built-in recipes, statusline states, slash commands, env vars
- [Explanation](./docs/explanation.md) - multi-server routing, startup failure classification, diagnostics push/pull, autodetection precedence

## Development

```sh
mise run build --package packages/pi-lsp      # build
mise run dev --package packages/pi-lsp        # build with sourcemaps (watch)
mise run test --package packages/pi-lsp
mise run typecheck --package packages/pi-lsp
hk check                                       # eslint + prettier (repo-wide)
```

Regenerate the config JSON Schema after changing `src/types.ts`:

```sh
bun run --cwd packages/pi-lsp gen:schema
```

## Validation

- **Static**: `mise run typecheck --package packages/pi-lsp` + `hk check`.
- **Functional**: requires a real LSP server binary (`typescript-language-server`, `pyright`, etc.) in a real project - no mocks.

## License

See [LICENSE](../../LICENSE).
