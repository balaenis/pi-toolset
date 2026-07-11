# Reference

Technical lookup for `@balaenis/pi-format`.

## Config file locations

- Global: `~/.pi/agent/@balaenis/pi-format/config.json`
- Project: `<cwd>/.pi/@balaenis/pi-format/config.json` (project overrides global
  by formatter name)

Both use JSONC syntax (comments allowed).

## Config fields

| Field                          | Type   | Default | Description                                                                                |
| ------------------------------ | ------ | ------- | ------------------------------------------------------------------------------------------ |
| `enabled`                      | bool   | `true`  | Master switch. `false` disables tool, command, and hook (still registered).                |
| `formatOnWrite`                | bool   | `true`  | When `false`, disables automatic post-`write`/`edit` formatting.                           |
| `formatters.<name>.disabled`   | bool   | `false` | Disable a single formatter.                                                                |
| `formatters.<name>.command`    | array  | -       | Override a built-in command or define a custom formatter. Must include `$FILE`.            |
| `formatters.<name>.extensions` | array  | -       | Override supported extensions. Required for custom formatters; each entry starts with `.`. |
| `formatters.<name>.timeoutMs`  | number | -       | Per-formatter timeout in milliseconds.                                                     |

## Built-in formatter recipes

| Formatter      | Extensions                                                                                           | Detection rule                                 |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `biome`        | `.js` `.jsx` `.ts` `.tsx` `.json` `.jsonc` `.css`                                                    | `biome.json`/`biome.jsonc` and `biome` on PATH |
| `prettier`     | `.js` `.jsx` `.ts` `.tsx` `.mjs` `.cjs` `.css` `.scss` `.json` `.jsonc` `.yaml` `.yml` `.md` `.html` | `prettier` on PATH                             |
| `ruff`         | `.py` `.pyi`                                                                                         | `ruff` on PATH                                 |
| `gofmt`        | `.go`                                                                                                | `gofmt` on PATH                                |
| `rustfmt`      | `.rs`                                                                                                | `rustfmt` on PATH                              |
| `shfmt`        | `.sh` `.bash` `.zsh`                                                                                 | `shfmt` on PATH                                |
| `clang-format` | `.c` `.cc` `.cpp` `.cxx` `.h` `.hh` `.hpp` `.hxx`                                                    | `.clang-format` and `clang-format` on PATH     |

Detection is conservative: if a formatter is not clearly available it is not
used. Recipes are never installed implicitly.

## `/format` command

```sh
/format [--formatter <name>] <file...>
```

Formats one or more files. Without `--formatter`, the formatter is chosen by
extension and PATH availability. Appears in slash autocomplete.

## `format` tool

The LLM-callable `format` tool formats the files it is given using the same
detection and config as the `/format` command. It is the programmatic
counterpart of the slash command.
