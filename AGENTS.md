# Instructions

## Goal

Implement LSP support for Pi. Before acting, identify the deliverable, constraints, and allowed side effects. Choose the most efficient path that satisfies them.

## Success Criteria

- The requested change is complete and in the requested shape
- Validation passes before reporting done
- Missing information, permissions, or blockers are surfaced rather than hidden

## Constraints

- Keep comments to a minimum — let the code speak for itself
- Match surrounding style and formatting
- Make the smallest reasonable change that solves the task
- Do not introduce mock modes or fake data paths
- Every code file must start with a 2-line ABOUTME comment describing what it does (each line starts with "ABOUTME: ")
- Reference `Claude Code` source at `@/home/julian/workspace/source/claude-code-2.1.88/package-src/src` when useful

### Development

Use `mise` to manage the development environment; `bun` as the package manager; `bunx` for one-off tools.

- `mise run typercheck` — TypeScript type check
- `mise run build` — Build the module
- `mise run test` — Run tests
- `hk check` — eslint + prettier
- `hk fix` — apply eslint + prettier fixes

### Documentation

- Update the README with any new or changed usage instructions.
- Add any new or changed configuration options to the README.
- If there are suitable test instruction steps, put them in the README.

## Validation

After a change, run the most relevant check: targeted tests for changed behavior, type checks, lint. If validation cannot run, state why and give the next best check.

## Stop Rules

- Ask before: replacing an entire implementation, destructive or irreversible actions, changing secrets, or acting outside the request scope
- Stop and report when a change requires more context than available
