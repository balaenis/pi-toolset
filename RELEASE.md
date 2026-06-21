# Release Process

This is a monorepo (`pi-toolset`) of independently versioned Pi extension packages. Each package under `packages/` is released on its own version, changelog, git tag, and npm publish cadence using [release-please](https://github.com/googleapis/release-please) **manifest mode** + [Npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC).

There are two release channels per package:

- **Stable (`latest`):** merging a release-please release PR publishes a stable version to the `latest` npm dist-tag.
- **Pre-release (`next`):** opening/updating a release-please release PR publishes a `x.x.x-next.N` snapshot to the `next` npm dist-tag for testing.

You can also trigger a manual release from the GitHub Actions tab (see [Manual Releases](#manual-releases)).

## Repository Layout

```
release-please-config.json        # manifest-mode config: one entry per package
.release-please-manifest.json     # per-package current version tracker
packages/<name>/package.json      # each package owns its version
```

Only list packages that exist in `release-please-config.json` (release-please errors on a configured path with no `package.json`).

## Conventional Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `fix:` patches
- `feat:` minor features
- `feat!:` or `fix!:` breaking changes

release-please attributes a commit to a package by the path it touches. A commit touching `packages/pi-lsp/**` bumps only `pi-lsp`. Commits touching multiple packages bump all of them in one consolidated release PR. Root-only commits (e.g. `chore:` on `mise.toml`) bump nothing unless a package path is also touched.

### Pre-1.0 Versioning

While a package version is `0.x.x`, breaking changes bump **minor** (`bump-minor-pre-major: true`).

## Tags

Tags are component-scoped (`include-component-in-tag: true`): `pi-lsp-v0.1.0`, `other-package-v0.2.0`. This prevents collisions between packages.

## First Release (per package)

Before automated releases work for a package, perform its first release manually. Repeat for each package.

Why:

- This uses [Npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers).
- The first release creates the npm package on npmjs.com.
- That then allows trusted publishing with GitHub Actions for future releases.

### Steps

1. Confirm the package's `package.json` is correct:
   - `version` is `0.0.1`
   - package name (with scope) is correct
   - `repository.url` points to `https://github.com/balaenis/pi-toolset.git`
   - `files`, `exports`, and `pi.extensions` are correct

2. Run `npm login` to authenticate with npm.

3. Build and publish the first version from the repository root:

   ```sh
   mise run build --package packages/pi-lsp
   mise run publish --package packages/pi-lsp --otp <your-2fa-code>
   ```

4. Push a **bootstrap component tag** so the `next` self-skip logic has a baseline (the tag name must match `include-component-in-tag: true`):

   ```sh
   git tag pi-lsp-v0.0.1
   git push origin pi-lsp-v0.0.1
   ```

5. On npmjs.com, add a trusted publisher for the package:
   - **Organization or user:** `balaenis`
   - **Repository:** `pi-toolset`
   - **Workflow filename:** `publish.yml`
   - **Allowed actions:** select at least `npm publish`

6. [Restrict token access](https://docs.npmjs.com/trusted-publishers#recommended-restrict-token-access-when-using-trusted-publishers) for maximum security.

## Release Workflow

### Automated process

1. Push commits to `main`.
2. release-please (`release.yml`) analyzes commits per package and opens/updates a single consolidated release PR with version bumps, `CHANGELOG.md` updates, and `package.json`/`src/version.ts` bumps for each changed package.
   - Opening/updating the release PR dispatches a `next` publish for every workspace package (packages with no new commits since their last component tag self-skip).
3. Review and merge the release PR.
   - Merging dispatches a `latest` publish for each path that had a release created (`paths_released`).

### Version sources

| Channel  | Trigger                   | Version                                                         | Example         |
| -------- | ------------------------- | --------------------------------------------------------------- | --------------- |
| `latest` | release PR merged         | release-please `default` strategy from conventional commits     | `0.1.0`         |
| `next`   | release PR opened/updated | `<release-of-last-released>-next.<commits-since-component-tag>` | `0.0.1-next.14` |

The `next` snapshot is a prerelease of the **last-released** version plus the commits since that package's last component tag (a preview of "what is on `main` since the last release"). It is computed by the `publish` task, not release-please.

## Manual Releases

Trigger `publish.yml` from the GitHub Actions tab ("Run workflow"), supplying:

- **path:** the package directory, e.g. `packages/pi-lsp`
- **tag:** `latest` or `next`

This builds and publishes that one package via OIDC trusted publishing. Use manual releases for hot-fixes outside the normal release cycle.

## Publishing

Releases are published to npm when the release-please PR is merged (`latest`) or when it is opened/updated (`next`).

### NPM Trusted Publishing

No npm tokens are needed — authentication is handled via OIDC. Each publish uses short-lived, cryptographically-signed tokens specific to the workflow, with automatic provenance attestations.

Trusted publishing is configured **per npm package**, all pointing at the shared `publish.yml` workflow in this repo (see [First Release](#first-release-per-package)).

## Advanced Release Features

### Force a Specific Version

Use the `Release-As` footer in a commit message (touching the package path) to force a specific version:

```sh
git commit --allow-empty -m "chore: release pi-lsp 2.0.0" -m "Release-As: 2.0.0"
```

release-please will open a PR for version `2.0.0` for that package regardless of commit message types.

### Update Extra Files During Release

`src/version.ts` is updated per package via `extra-files` in `release-please-config.json`. The `x-release-please-version` magic comment marks the version constant. To track version in additional files, add them to that package's `extra-files` array.

Supported file types: generic, JSON (JSONPath), YAML (JSONPath), XML (XPath), TOML (JSONPath).

### Magic Comments for Version Markers

- `// x-release-please-version` — full semver
- `// x-release-please-major` / `x-release-please-minor` / `x-release-please-patch` — individual numbers

## Do Not

- Manually edit release-please release PRs
- Manually create GitHub releases for a package
- Manually edit a package's `version` (release-please owns `latest`; the `publish` task owns `next`)
- Delete a package's component tags (the `next` self-skip relies on them)
