# Tutorial: Format files from Pi

This tutorial gets you from a built extension to automatic formatting on save.
You will load the extension, format a file explicitly, observe format-on-write,
and check which formatter was detected.

It assumes you are familiar with [Pi](https://github.com/earendil-works/pi) and
have the repo checked out locally.

## Prerequisites

- The `pi` CLI installed and on `PATH`.
- At least one formatter on `PATH` for the languages you edit. Built-in detection
  covers Prettier, Biome, Ruff, gofmt, rustfmt, shfmt, and clang-format (see
  [Reference: built-in recipes](./reference.md#built-in-formatter-recipes)).

## 1. Build and load the extension

The package is not published to a registry yet. Build it and load it with `-e`:

```sh
mise run build --package packages/pi-format
pi -e ./packages/pi-format/dist/index.js
```

Pi now has the `format` tool and the `/format` slash command. With default
config, formatting is enabled and format-on-write is on.

## 2. Format a file explicitly

Run the slash command on a file:

```sh
/format src/index.ts
```

Or ask Pi to call the `format` tool directly. The extension picks a formatter
based on the file extension and what is available on `PATH`, then runs it on the
file. A formatter failure does not convert a successful edit into an error -
formatting is best-effort.

## 3. Observe format-on-write

With `enabled` and `formatOnWrite` both `true` (the defaults), any successful
built-in `write` or `edit` tool call automatically triggers formatting on the
target file. Edit a file through Pi and watch the formatter run afterwards.

Because formatting runs after the edit result is computed, the diff shown by
Pi's built-in `edit` tool does not include formatter-produced changes.

## 4. Check which formatter was detected

Detection is conservative: a formatter is used only when it is clearly available.
For example, `clang-format` requires both `.clang-format` and `clang-format` on
`PATH`; `biome` requires `biome.json`/`biome.jsonc` and `biome` on `PATH`. If no
formatter is clearly available for an extension, the file is left untouched.

You can override detection or add a custom formatter via config - see the
[How-to guides](./how-to.md).

## Next steps

- [How-to guides](./how-to.md) for toggling format-on-write, adding custom
  formatters, and overriding built-ins.
- [Reference](./reference.md) for config fields, built-in recipes, and command
  syntax.
- [Explanation](./explanation.md) for how auto-format hooks into `write`/`edit`
  and why it does not override them.
