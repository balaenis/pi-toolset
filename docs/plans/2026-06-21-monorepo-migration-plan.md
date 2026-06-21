# Monorepo Migration Plan: `pi-toolset`

**Goal:** Consolidate `pi-lsp` and future Pi-related extension packages into a single `pi-toolset` monorepo, each package independently versioned and released via release-please manifest mode, while preserving the existing dual-channel (`latest` stable / `next` prerelease snapshot) publish flow.

**Inputs:** User request on 2026-06-21. Current single-package repo at `/home/julian/workspace/my/pi-lsp` using release-please + NPM Trusted Publishing (OIDC). `@balaenis/pi-lsp` is **not yet published** to npm (404), so this migration happens before the first release — no legacy tags or published versions to reconcile.

**Authoritative sources consulted:**

- `release-please` manifest-releaser docs (`docs/manifest-releaser.md`).
- `release-please-action` v4 README (outputs, inputs, v3→v4 mapping).
- `release-please` config JSON schema (`schemas/config.json`) — confirms `versioning`, `prerelease`, `include-component-in-tag`, `tag-separator`, `separate-pull-requests`, `node-workspace.updatePeerDependencies` are all valid keys.
- Existing repo evidence: `package.json`, `release-please-config.json`, `.release-please-manifest.json`, `RELEASE.md`, `.github/workflows/*.yml`, `.mise/tasks/{build,publish,version}`.

---

## Confirmed Decisions

**D1 — Package independence (user, 2026-06-21):** Packages that get published are independent: each owns its own version, changelog, git tag, GitHub Release, and publish cadence. Shared code may be extracted for reuse when justified (see [Shared Code Evolution Path](#shared-code-evolution-path)).

**D2 — Versioning (user, 2026-06-21):** `latest` channel publishes **stable** versions; `next` channel publishes **prerelease** snapshot versions. This matches the existing `RELEASE.md` dual-channel model. Consequence: drop the current root `versioning: "prerelease"` and `prerelease: true` so release-please uses the `default` strategy and emits stable semver on release-PR merge. The `next` prerelease version is computed at publish time, as today.

**D3 — PR strategy:** `separate-pull-requests: false` (default). One consolidated release PR collects all packages with changes; each package inside it still gets its own version bump, tag, and release. Rationale: `true` is known to cause `.release-please-manifest.json` merge collisions when multiple release PRs land near-simultaneously (googleapis/release-please#2746, release-please-action#526). "Independent version" does not require "independent PR".

**D4 — Component tags:** `include-component-in-tag: true` (was `false` for the single-package layout). Required in a multi-package repo so packages do not collide on `v0.0.1`. Tags become `<component>-v<version>` (e.g. `pi-lsp-v0.0.1`). No migration concern since no tags exist yet.

**D5 — Trusted Publishing scope:** npm Trusted Publishing is keyed on `(org/repo, workflow filename)`, not on workflow inputs. Every published package configures its trusted publisher as `balaenis/pi-toolset` + `publish.yml`. One workflow file serves all packages. First release of each package is still manual (per `RELEASE.md` "First Release"), then trusted publishing takes over.

---

## Target Repository Structure

```
pi-toolset/
  package.json                      # root workspace manifest; private; shared toolchain devDeps
  bun.lock
  mise.toml                         # root mise tool versions + env
  .mise/tasks/                      # parameterized build/publish/typecheck/test; root check/lint/format
  eslint.config.js                  # repo-wide flat config (stays at root for `hk check`)
  hk.pkl / .prettierrc              # repo-wide lint config
  release-please-config.json        # manifest-mode config (all packages)
  .release-please-manifest.json     # per-package current version tracker
  .github/
    workflows/
      release.yml                   # release-please + dispatch (per-path)
      publish.yml                   # per-package OIDC publish (path + tag inputs)
      pr.yml                        # CI checks across workspace
      lint-pr-title.yml
      stale.yml
  packages/
    pi-lsp/
      package.json                  # @balaenis/pi-lsp, own version/deps/files
      src/ tests/ tsconfig.json CHANGELOG.md README.md
      src/version.ts
    other-package/
      package.json
      src/ ...
```

Root `package.json` (bun workspaces; follows repo convention of no `scripts` — build logic lives in mise tasks). The shared toolchain (`eslint`, `prettier`, `typescript`, `typescript-eslint`, `@eslint/js`, `bun-types`, `@types/node`, `eslint-config-prettier`, `eslint-plugin-prettier`) lives in root `devDependencies` so bun generates a root `node_modules/.bin` and the root `eslint.config.js` can resolve its imports — see [Implementation Notes](#implementation-notes---deviations-from-plan):

```json
{
  "name": "pi-toolset",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^26.0.0",
    "@typescript-eslint/eslint-plugin": "8.61.1",
    "@typescript-eslint/parser": "8.61.1",
    "bun-types": "^1.3.14",
    "eslint": "^10.5.0",
    "eslint-config-prettier": "10.1.8",
    "eslint-plugin-prettier": "^5.5.6",
    "prettier": "^3.8.4",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.61.1"
  }
}
```

`packages/pi-lsp/package.json` keeps its current `name`, `version`, `exports`, `pi`, `peerDependencies`, `files`. Changes: `repository.url` → `https://github.com/balaenis/pi-toolset.git`; add `pi.external: ["vscode-jsonrpc"]` so the parameterized `build` externalizes it; the shared toolchain devDeps move up to the root, leaving only the Pi SDK peers, `typebox`, and the `vscode-languageserver-*` packages here. `vscode-languageserver-types` is declared explicitly (it is imported directly from `src/tools.ts` at runtime and was only a transitive dep of `vscode-languageserver-protocol`; bun workspaces do not hoist transitive deps into a resolvable position).

---

## release-please Configuration

`release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "include-v-in-tag": true,
  "include-component-in-tag": true,
  "bump-minor-pre-major": true,
  "separate-pull-requests": false,
  "packages": {
    "packages/pi-lsp": {
      "component": "pi-lsp",
      "release-type": "node",
      "extra-files": ["src/version.ts"]
    },
    "packages/other-package": {
      "component": "other-package",
      "release-type": "node"
    }
  }
}
```

`.release-please-manifest.json` (initial; each package bootstraps at `0.0.1`):

```json
{
  "packages/pi-lsp": "0.0.1",
  "packages/other-package": "0.0.1"
}
```

Notes:

- **No `release-type` at the action level** — in v4, omitting `release-type` activates manifest mode (reads the two files above). The current `release.yml` sets `release-type: node`, which is the single-package form and would ignore `packages`; it must be removed.
- **`node-workspace` plugin:** **not used initially.** Packages are independent today (D1), and the plugin inspects all node package configs and appends a `package-lock.json` update — this repo uses `bun.lock`, so the plugin would no-op on the lockfile while still making extra API calls. Add `{ "type": "node-workspace", "updatePeerDependencies": true }` to `plugins` only when [Shared Code Evolution Path](#shared-code-evolution-path) Option A is taken (a shared package is introduced and depended upon via `workspace:*`). `updatePeerDependencies: true` is then relevant because Pi extension packages rely heavily on `peerDependencies` (the host provides the Pi SDK).
- **`extra-files: ["src/version.ts"]`** is per-package; release-please resolves it relative to the package directory. Each package that embeds a version constant declares its own `extra-files`.

---

## Versioning Strategy (D2)

| Channel             | Trigger                                  | Version source                                                                       | Example         |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ | --------------- |
| `latest` (stable)   | release-please release PR merged         | release-please `default` strategy from conventional commits                          | `0.1.0`         |
| `next` (prerelease) | release-please release PR opened/updated | computed at publish: `<release-of-last-released>-next.<commits-since-component-tag>` | `0.0.1-next.14` |

Drop `versioning: "prerelease"` + `prerelease: true` from the root config. release-please then computes stable bumps (`feat` → minor under pre-1.0 via `bump-minor-pre-major`, `fix` → patch, `feat!`/`fix!` → minor under pre-1.0). The `next` snapshot version is **not** managed by release-please; the `publish` task derives it from commit count scoped to the package path and the component tag pattern.

**`next` version base — important nuance:** the `next` dispatch fires on `prs_created` (release PR opened/updated) and the publish task reads `package.json` from `main`, where the version is still the **last-released** version (release-please only bumps `package.json` when the release PR merges). So `next` snapshots are prereleases of the last-released version plus the commits since — e.g. if `0.0.1` is the last release, the snapshot is `0.0.1-next.14`, a preview of "what is on `main` since `0.0.1`". This matches the existing single-package behavior. If the desired semantics is instead to preview the **upcoming** bump (e.g. `0.1.0-next.14`), the dispatch must run from the release PR branch or parse release-please's proposed version — see [Open Items](#open-items).

---

## Shared Code Evolution Path (D1)

When a second package arrives and genuine duplication emerges, choose one of:

**Option A — Shared package, published (recommended).** Extract into `packages/pi-common` (name e.g. `@balaenis/pi-common`), listed in `release-please-config.json` like any other package. Consumers declare it in `dependencies` as `"@balaenis/pi-common": "workspace:*"` and **externalize it at build time** (add to `build` externals) so the bundle does not inline a second copy. `node-workspace` then bumps dependents when the shared package releases. This matches how the Pi SDK itself is treated (peer-provided, not bundled) and keeps publish artifacts lean.

**Option B — Internal module, not published.** Extract into `packages/pi-common` with `"private": true` and **exclude it from `release-please-config.json`**. Reference it via `workspace:*` + tsconfig path mapping and **inline it at build time** (do not externalize). No version coordination needed; `node-workspace` ignores it. Trade-off: every consumer bundle carries a copy of the shared code, and the module cannot be reused outside the workspace.

**Recommendation:** start with packages fully independent (no shared package). When duplication is concrete, prefer Option A so the publish graph stays consistent with the "peer-provided, externalized" model the Pi extension packages already use. Add the shared package to `release-please-config.json` **and** enable the `node-workspace` plugin at that point; the plugin then handles dependent version bumps without further config change.

---

## GitHub Workflows

### `.github/workflows/release.yml`

Manifest mode (no `release-type`). Dispatches `publish.yml` per released path for `latest`, and per workspace package for `next` (the publish task self-skips packages with no new commits).

```yaml
name: Release
on:
  push:
    branches: [main]
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
permissions:
  contents: write
  pull-requests: write
  actions: write # createWorkflowDispatch for publish.yml

jobs:
  process:
    runs-on: ubuntu-latest
    outputs:
      releases_created: ${{ steps.rp.outputs.releases_created }}
      prs_created: ${{ steps.rp.outputs.prs_created }}
      paths_released: ${{ steps.rp.outputs.paths_released }}
    steps:
      - id: rp
        uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          # manifest mode: do NOT set release-type

  dispatch:
    needs: process
    runs-on: ubuntu-latest
    if: needs.process.outputs.releases_created == 'true' || needs.process.outputs.prs_created == 'true'
    steps:
      - uses: actions/checkout@v4

      - name: Dispatch latest publishes (per released path)
        if: needs.process.outputs.releases_created == 'true'
        uses: actions/github-script@v7
        env:
          PATHS_RELEASED: ${{ needs.process.outputs.paths_released }}
        with:
          script: |
            const paths = JSON.parse(process.env.PATHS_RELEASED || '[]');
            for (const path of paths) {
              await github.rest.actions.createWorkflowDispatch({
                owner: context.repo.owner, repo: context.repo.repo,
                workflow_id: 'publish.yml', ref: 'main',
                inputs: { path, tag: 'latest' },
              });
              core.info(`dispatched latest: ${path}`);
            }

      - name: Dispatch next snapshots (all workspace packages)
        if: needs.process.outputs.prs_created == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const dirs = fs.readdirSync('packages', { withFileTypes: true })
              .filter(d => d.isDirectory() && fs.existsSync(`packages/${d.name}/package.json`))
              .map(d => `packages/${d.name}`);
            for (const path of dirs) {
              await github.rest.actions.createWorkflowDispatch({
                owner: context.repo.owner, repo: context.repo.repo,
                workflow_id: 'publish.yml', ref: 'main',
                inputs: { path, tag: 'next' },
              });
              core.info(`dispatched next: ${path}`);
            }
```

`paths_released` is threaded through `env` (not YAML interpolation) to avoid JSON quoting issues. `actions/github-script`'s `createWorkflowDispatch` replaces the current `peter-evans/repository-dispatch` because `workflow_dispatch` carries `inputs` (we need `path`).

### `.github/workflows/publish.yml`

Accepts `path` + `tag`; builds and publishes one package.

```yaml
name: Publish Package
on:
  workflow_dispatch:
    inputs:
      path:
        description: 'Package directory, e.g. packages/pi-lsp'
        required: true
      tag:
        description: 'npm tag'
        required: true
        type: choice
        options: [latest, next]
permissions:
  id-token: write
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          fetch-tags: true
      - uses: jdx/mise-action@d6e32c1796099e0f1f3ac741c220a8b7eae9e5dd
        with:
          install: true
          cache: true
          experimental: true
      - name: Build
        run: mise run build --package ${{ inputs.path }}
      - name: Publish
        run: mise run publish --package ${{ inputs.path }} --tag ${{ inputs.tag }}
```

### `.github/workflows/pr.yml`

CI runs across the workspace. Replace `mise run build` / `mise run test` with parameterized loops over `packages/*`, or add a workspace-aware `mise run check-all` task. Scope of this change is limited to iterating package directories; per-package `mise run typecheck/test/build` already work from inside each package dir.

---

## mise Tasks

### `.mise/tasks/build` (parameterized)

```bash
#!/usr/bin/env bash
#MISE description="Build a package"
#MISE depends=["setup"]
#USAGE flag "-p --package <path>" "Package dir, e.g. packages/pi-lsp" default=""

set -e
PKG="${usage_package}"
[ -d "$PKG" ] || { echo "no such package: ${usage_package:-<missing>}" >&2; exit 1; }
cd "$PKG"

# Externalize peer packages (host provides them at runtime) + this package's extra externals.
EXTERNALS=$(jq -r '(.peerDependencies//{}) | keys[]' package.json)
# Per-package extra externals (e.g. pi-lsp externalizes vscode-jsonrpc):
EXTRA=$(jq -r '(.pi.external // [])[]' package.json 2>/dev/null || true)

args=()
for e in $EXTERNALS $EXTRA; do args+=(--external "$e"); done

bun build ./src/index.ts --outdir dist --target node "${args[@]}"
```

> Convention: a package may declare extra build-time externals under a `pi.external` array in its `package.json` (e.g. `["vscode-jsonrpc"]` for `pi-lsp`). Peer deps are externalized automatically. This generalizes the current hardcoded `--external` list and also externalizes `@earendil-works/pi-tui` (imported by `src/status-command.ts`), which the old hardcoded build omitted — bundling it would have inlined a second Pi SDK instance, contradicting the "host provides peers" model.

### `.mise/tasks/publish` (parameterized)

```bash
#!/usr/bin/env bash
#MISE description="Publish a package to npm"
#MISE depends=["setup"]
#USAGE flag "-p --package <path>" "Package dir, e.g. packages/pi-lsp" default=""
#USAGE flag "-t --tag <tag>" "npm tag" default="latest"
#USAGE flag "-d --dry-run" "Dry run" default=false
#USAGE flag "--otp <otp>" "2FA OTP" default=""

set -e
PKG="${usage_package}"
TAG="${usage_tag}"
COMPONENT=$(basename "$PKG")
[ -d "$PKG" ] || { echo "no such package: ${usage_package:-<missing>}" >&2; exit 1; }

# Ensure the package is built before publishing.
mise run build --package "$PKG"

cd "$PKG"

if [ "$TAG" = "next" ]; then
  # Match only this component's tags (include-component-in-tag: true).
  LAST_TAG=$(git describe --tags --abbrev=0 --match "${COMPONENT}-v*" 2>/dev/null || echo "")
  if [ -n "$LAST_TAG" ]; then
    BUILD_NUMBER=$(git rev-list "${LAST_TAG}..HEAD" --count -- .)
  else
    BUILD_NUMBER=$(git rev-list HEAD --count -- .)
  fi
  if [ "$BUILD_NUMBER" -eq 0 ]; then
    echo "no commits to $PKG since $LAST_TAG; skipping next"
    exit 0
  fi

  CURRENT_VERSION=$(jq -r '.version' package.json)
  PRERELEASE_VERSION="$(semver get release "$CURRENT_VERSION")-next.${BUILD_NUMBER}"
  echo " > $CURRENT_VERSION -> $PRERELEASE_VERSION"
  [ "$usage_dry_run" != "true" ] && npm version "$PRERELEASE_VERSION" --no-git-tag-version --allow-same-version
fi

args=()
[ -n "$usage_otp" ] && args+=(--otp "$usage_otp")
[ -n "$GITHUB_ACTIONS" ] && args+=(--provenance)

if [ "$usage_dry_run" != "true" ]; then
  npm publish --access public --tag "$TAG" "${args[@]}"
else
  echo "dry-run: npm publish --access public --tag $TAG ${args[*]}"
fi
```

Key behaviors:

- `git describe --match "${COMPONENT}-v*"` scopes to the component's tags (pairs with `include-component-in-tag: true`).
- `git rev-list ... -- .` counts only commits touching the package directory, so untouched packages yield `BUILD_NUMBER=0` and self-skip — this prevents `next` snapshots from republishing an identical version (npm 409) and makes the blanket `next` dispatch in `release.yml` safe.
- `cd "$PKG"` ensures `npm publish` reads the right `package.json` and `dist/`.

### `.mise/tasks/version`

Dropped. release-please owns `latest` and the `publish` task owns `next`; a separate local bump helper would be a second source of truth for versions.

### `#USAGE` flag syntax (required)

The `#USAGE` parser in this mise version does not accept `required` in any form (`required=true`, `required="true"`, or a KDL block all fail to parse, and the flags silently go unpopulated). All parameterized flags therefore use `default=""` and rely on an in-script `[ -d "$PKG" ]` guard to reject a missing/invalid `--package`. `lint`/`check`/`format`/`setup` stay repo-wide and take no `--package`.

---

## Migration Steps

1. **Create `pi-toolset` repo** (empty) at `github.com/balaenis/pi-toolset`.
2. **Scaffold root:** root `package.json` (workspaces, private, shared toolchain `devDependencies`), `mise.toml` (copy tool versions), `.mise/tasks/` (parameterized build/publish/typecheck/test + repo-wide check/lint/format/setup), `eslint.config.js`/`hk.pkl`/`.prettierrc` (stay at root for `hk check`), `release-please-config.json`, `.release-please-manifest.json` (initial `0.0.1` per package), `.github/workflows/{release,publish,pr,lint-pr-title,stale}.yml`, `.gitignore`, `AGENTS.md`.
3. **Move `pi-lsp` into `packages/pi-lsp`:** preserve `src/`, `tests/`, `tsconfig.json`, `README.md`, `CHANGELOG.md` (keep `eslint.config.js` at the root, not here). Update its `package.json` `repository.url` → `pi-toolset.git`; move the shared toolchain devDeps up to the root; add `pi.external: ["vscode-jsonrpc"]`; declare `vscode-languageserver-types` explicitly as a devDep (imported directly from `src/tools.ts`; only a transitive dep of `vscode-languageserver-protocol`). Add `src/version.ts` with the `x-release-please-version` magic comment.
4. **Add `packages/other-package`** placeholder when ready (or omit until it exists — release-please errors if a configured path has no `package.json`, so only list packages that exist).
5. **First release (per package), manual, per `RELEASE.md`:** `npm login`; `mise run build --package packages/pi-lsp`; `mise run publish --package packages/pi-lsp --otp <code>`; then **push a bootstrap component tag** so the `next` self-skip logic has a baseline (`git tag pi-lsp-v0.0.1 && git push origin pi-lsp-v0.0.1` — the tag name matches `include-component-in-tag: true`); then on npmjs.com add a trusted publisher for `@balaenis/pi-lsp` with organization/repo `balaenis/pi-toolset`, workflow filename `publish.yml`, and **Allowed actions** selecting at least `npm publish`. Repeat for each package's debut.
6. **Update release docs:** update `RELEASE.md` and each package's `README.md` for monorepo commands — component tags (`pi-lsp-v<version>` instead of `v<version>`), the new required `path` input to `publish.yml`, per-package trusted-publisher setup, and the parameterized `mise run build/publish --package ...` invocations.
7. **Verify workflows:** push to `main`, confirm release-please opens a consolidated release PR; merge it; confirm `publish.yml` fires per released path with `latest`; push a `feat:` commit, confirm a `next` dispatch fires and the publish task self-skips untouched packages.

---

## Implementation Notes — Deviations from Plan

This section records where the implementation diverged from the plan above and why. The divergence points are already reflected in the structure/code blocks above; this records the rationale.

1. **`eslint.config.js` stays at the root** (the structure diagram originally listed it under `packages/pi-lsp`). `hk.pkl` runs `eslint {{files}}` from the repo root with a flat config, which ESLint resolves by walking up from `cwd` — the config must live at the root, not inside a package. Moving it into `packages/pi-lsp` would break `hk check`.
2. **Shared toolchain hoisted to root `devDependencies`** (the plan originally had an empty root `package.json`). With only workspace packages and no root deps, bun does not create a root `node_modules/.bin`, so `hk check`'s `eslint` invocation fails with `command not found`, and the root `eslint.config.js` cannot resolve `@eslint/js`/`typescript-eslint`. Declaring the shared toolchain at the root fixes both and also pins `typescript` so `tsc` runs on a project-controlled version instead of the mise-installed global `tsc`.
3. **`vscode-languageserver-types` declared explicitly** in `packages/pi-lsp/devDependencies`. `src/tools.ts` imports it at runtime; in the single-package layout it was resolvable as a transitive dep of `vscode-languageserver-protocol` via bun's flat hoisting, but bun workspaces do not hoist transitive deps into a resolvable position, so the workspace move broke `tsc` until it was declared directly.
4. **`#USAGE` flags use `default=""`, not `required=true`** (the plan originally wrote `required=true`). This mise version's `#USAGE` parser rejects `required` in every form tried (`required=true`, `required="true"`, KDL block), and on failure the flag variables stay silently empty — so `mise run build --package ...` would see an empty `usage_package`. The fix is `default=""` plus an in-script `[ -d "$PKG" ]` guard that exits non-zero with a clear message when `--package` is missing or invalid.
5. **Bonus: `@earendil-works/pi-tui` now externalized.** The old hardcoded `build` externalized `pi-ai`, `pi-coding-agent`, `typebox`, and `vscode-jsonrpc` but **omitted `pi-tui`**, even though `src/status-command.ts` imports it — the old build silently inlined a second Pi TUI instance, contradicting the "host provides peers" comment. The new automatic `peerDependencies` externalization fixes this.

---

## Risks & Notes

- **`separate-pull-requests: true`** is intentionally avoided (D3) due to known manifest-file merge collisions. If a hard requirement for per-package PRs ever arises, revisit with `sequential-calls: true` and accept the conflict risk.
- **`next` blanket dispatch:** safe because the publish task self-skips packages with no new commits since their last component tag. **Requires the bootstrap component tag from migration step 5** — before that tag exists, the self-skip falls back to counting all commits touching the package and would not skip. Verify the skip path in CI before relying on it.
- **OIDC provenance:** `--provenance` is added only inside `GITHUB_ACTIONS`. Each package needs its own first manual release + trusted-publisher setup; the shared `publish.yml` then covers all packages.
- **`GITHUB_TOKEN` dispatch limitation:** events triggered by `GITHUB_TOKEN` do not spawn new workflow runs. `release.yml` uses `createWorkflowDispatch` (an API call with the same token) which **does** start `publish.yml` — this is the intended pattern and is not subject to that limitation. If CI checks are later needed _on_ release-please PRs, switch `release.yml`'s `token` to a PAT (per action README) so checks trigger.
- **`node-workspace` plugin:** not enabled initially (D1). The plugin also appends a `package-lock.json` update, which is irrelevant to this `bun.lock`-based repo. Enable it only when [Shared Code Evolution Path](#shared-code-evolution-path) Option A is taken.
- **Conventional commit scoping:** release-please attributes a commit to a package by the path the commit touches. A commit touching `packages/pi-lsp/**` bumps only `pi-lsp`. Commits touching multiple packages bump all of them in the consolidated PR. Root-only commits (e.g. `chore:` on `mise.toml`) bump nothing unless a package path is also touched.

---

## Open Items

- **`pr.yml` workspace check shape:** decide between a `mise run check-all` wrapper task vs. an explicit loop in the workflow. Minor; pick when implementing.
- **`version` task disposition:** resolved — dropped (release-please owns `latest`, `publish` owns `next`).
- **`other-package` timing:** create the directory before listing it in `release-please-config.json`, or keep the config limited to `packages/pi-lsp` until the second package is real.
- **`next` version semantics:** the plan ships `next` as a prerelease of the **last-released** version (matches existing single-package behavior). If the intent is to preview the **upcoming** bump instead, the publish trigger must run from the release PR branch or parse release-please's proposed version — a separate design change. Confirm desired semantics before implementing.
