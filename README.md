# pi-toolset

A monorepo of [Pi](https://github.com/earendil-works/pi) extension packages. Each package under `packages/` is independently versioned and released.

## Packages

| Package                            | Description                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| [`pi-lsp`](packages/pi-lsp/)       | LSP support for Pi (language-server lifecycle, diagnostics, tools, statusline) |
| [`pi-format`](packages/pi-format/) | Format files via tool, `/format` command, and automatic post-write/edit hook   |
| [`pi-agents`](packages/pi-agents/) | Delegate tasks to specialized subagents with isolated context windows          |

The packages target the npm names `@balaenis/pi-lsp`, `@balaenis/pi-format`, and `@balaenis/pi-agents`, but are not published to a registry yet. Until they are, load them from a local build with `pi -e` (see each package's README).

See each package's `README.md` and `docs/` for usage and configuration.

## Repository layout

```
packages/<name>/          # independently released packages
release-please-config.json        # manifest-mode release config
.release-please-manifest.json     # per-package version tracker
.mise/tasks/              # parameterized tasks (build/test/typecheck/publish take --package)
```

## Getting started

This repo uses [`mise`](https://mise.jdx.dev) for tooling and [`bun`](https://bun.sh) as the package manager (bun workspaces).

```sh
mise run setup                                        # install workspace deps + hk
mise run build --package packages/pi-lsp              # build a package
pi -e ./packages/pi-lsp/dist/index.js                 # load it into Pi
```

## Development

Per-package tasks take `--package`:

```sh
mise run typecheck --package packages/pi-lsp
mise run test --package packages/pi-lsp
mise run build --package packages/pi-lsp
mise run check                                        # hk check (eslint + prettier, repo-wide)
```

## Releasing

Releases are automated via release-please manifest mode + NPM Trusted Publishing. Each package has independent `latest` (stable) and `next` (prerelease) channels. See [RELEASE.md](RELEASE.md) for the full process, including first-release setup per package.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
