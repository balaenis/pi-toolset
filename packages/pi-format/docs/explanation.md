# Explanation

Why `@balaenis/pi-format` is designed the way it is. For configuration recipes
see [How-to guides](./how-to.md); for field tables see [Reference](./reference.md).

## How auto-format hooks into write/edit

Registration is decided once at extension load (reload after config changes):

| Flag                                        | LLM `format` tool | `/format` command | Auto-format hook |
| ------------------------------------------- | ----------------- | ----------------- | ---------------- |
| defaults (`enabled` + `formatOnWrite` true) | registered        | registered        | registered       |
| `formatOnWrite: false`                      | registered        | registered        | not registered   |
| `enabled: false`                            | not registered    | registered        | not registered   |

`enabled: false` deliberately omits the LLM tool so it does not occupy model
attention. `/format` remains available for humans, including
`/format config <global|project>` to edit the config files from the TUI. When
the hook is registered, successful built-in `write`/`edit` results trigger
formatting on the target file.

When registered, the hook listens to `tool_result` events from Pi's built-in
`write`/`edit` tools. When such a tool succeeds, the extension runs the matching
formatter on the mutated file. Formatting is serialized with other mutations on
the same file via a `withFileMutationQueue`, so concurrent edits do not race the
formatter.

The extension does **not** override Pi's built-in `write`/`edit` tools - it
reacts to their results. Two consequences:

- The diff shown by Pi's built-in `edit` tool does not include formatter-produced
  changes, because formatting runs after the edit result is computed.
- A formatter failure does not convert a successful `write`/`edit` result into
  an error. Formatting is best-effort.

## Why not override write/edit

An advanced alternative would be to register replacement `write` and `edit`
tools so the formatter runs inside the tool call and the diff includes its
changes. This implementation intentionally avoids that approach because it has
higher maintenance risk when Pi core tool schemas, details, and rendering
assumptions change. Reacting to `tool_result` events is more resilient to core
changes at the cost of the formatter diff not appearing in the edit preview.

## Detection rules

Detection is conservative on purpose: a formatter is used only when it is
clearly available, so files are never silently passed to the wrong tool. The
rules:

- `biome` requires both a `biome.json`/`biome.jsonc` config file and `biome` on
  `PATH`.
- `clang-format` requires both a `.clang-format` file and `clang-format` on
  `PATH`.
- The others (`prettier`, `ruff`, `gofmt`, `rustfmt`, `shfmt`) require only the
  binary on `PATH`.

If no formatter is clearly available for an extension, the file is left
untouched. Recipes are never installed implicitly - you must have the formatter
installed for it to activate.

## Best-effort semantics

Automatic formatting is best-effort throughout:

- A formatter failure does not convert a successful `write`/`edit` result into
  an error.
- A formatter timeout (per-formatter `timeoutMs`) does not fail the edit.
- Explicit `/format` invocations do report formatter failures, since the user
  asked for formatting directly.
