# @balaenis/pi-format

Format files from [Pi](https://github.com/earendil-works/pi) using project-local formatters. Provides an LLM-callable `format` tool, a `/format` slash command, and automatic formatting after successful built-in `write`/`edit` tool calls.

## Features

- Explicit formatting via the `format` tool or `/format` command
- Automatic formatting after Pi's built-in `write` and `edit` tools succeed
- Built-in detection for Prettier, Biome, Ruff, gofmt, rustfmt, shfmt, and clang-format
- User-defined formatters and per-project overrides via JSONC config

## Local development

The package is not published to a registry yet. Build it and load it with `-e`:

```sh
mise run build --package packages/pi-format
pi -e ./packages/pi-format/dist/index.js
```

## Documentation

- [Tutorial: Format files from Pi](./docs/tutorials.md) - load the extension, format a file, observe format-on-write
- [How-to guides](./docs/how-to.md) - toggle format-on-write, add custom formatters, override or disable built-ins
- [Reference](./docs/reference.md) - config fields, built-in recipes, `/format` syntax
- [Explanation](./docs/explanation.md) - how auto-format hooks into write/edit, detection rules, best-effort semantics

## Development

```sh
mise run test --package packages/pi-format
mise run typecheck --package packages/pi-format
mise run build --package packages/pi-format
hk check
```

## License

See [LICENSE](../../LICENSE).
