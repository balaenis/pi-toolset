# How-to guides

Practical recipes for formatting. Each guide assumes you have
[built and loaded the extension](./tutorials.md#1-build-and-load-the-extension).

Configuration lives in two JSONC files; project overrides global by formatter
name:

- Global: `~/.pi/agent/@balaenis/pi-format/config.json`
- Project: `<cwd>/.pi/@balaenis/pi-format/config.json`

```jsonc
{
  "enabled": true,
  "formatOnWrite": true,
  "formatters": {
    "prettier": {
      "disabled": false,
      "command": ["bunx", "prettier", "--write", "$FILE"],
      "extensions": [".js", ".jsx", ".ts", ".tsx", ".json", ".md"],
    },
    "biome": { "disabled": true },
    "custom-md": {
      "command": ["markdownfmt", "$FILE"],
      "extensions": [".md"],
    },
  },
}
```

## Format files on demand

```sh
/format src/index.ts
/format --formatter prettier src/index.ts
```

The `format` tool can also be called by the LLM when it needs to format files.
Without `--formatter`, the extension picks a formatter by extension and PATH
availability.

## Enable or disable format-on-write

Set `formatOnWrite` to `false` to skip registering the automatic post-`write`/`edit`
hook while keeping explicit formatting available:

```jsonc
{ "formatOnWrite": false }
```

Hook registration is decided at extension load. After changing this value, run
`pi reload` (or restart Pi) so the extension re-reads config.

## Disable formatting for the model and auto-format

```jsonc
{ "enabled": false }
```

`enabled: false` skips registering the LLM-callable `format` tool and the
auto-format hook, so the model never sees a format tool. The `/format` slash
command still registers (for explicit use and future `/format config`). Reload
the extension after changing this value.

## Add a custom formatter

```jsonc
{
  "formatters": {
    "custom-md": {
      "command": ["markdownfmt", "$FILE"],
      "extensions": [".md"],
    },
  },
}
```

The `command` must include the `$FILE` token. `extensions` is required for
custom formatters; each entry must start with `.`.

## Override a built-in formatter

Override `command` and/or `extensions` for a built-in name:

```jsonc
{
  "formatters": {
    "prettier": {
      "command": ["bunx", "prettier", "--write", "$FILE"],
      "extensions": [".js", ".jsx", ".ts", ".tsx", ".json", ".md"],
    },
  },
}
```

## Disable a single built-in formatter

```jsonc
{
  "formatters": { "biome": { "disabled": true } },
}
```

`disabled: true` turns off one formatter without affecting the others.

## Set a per-formatter timeout

```jsonc
{
  "formatters": {
    "prettier": { "timeoutMs": 30000 },
  },
}
```

`timeoutMs` caps how long a single formatter run may take.
