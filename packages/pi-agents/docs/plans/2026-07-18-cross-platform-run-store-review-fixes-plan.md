# Cross-Platform RunStore Review Fixes Implementation Plan

**Goal:** Correct all ship-blocking review findings while preserving the pathname architecture, Version 1 compatibility, cooperative concurrency, and trusted-runs threat model.

**Inputs:** The original cross-platform RunStore implementation plan, the completed implementation diff, and the initial ship-readiness review.

**Assumptions:**

- The implementation and this plan will be staged before fixes begin; subsequent reviews inspect only unstaged changes relative to that index baseline.
- Explicit `rootDir: ''` is invalid; empty `PI_AGENTS_RUNS_DIR` remains ignored.
- Native macOS and Windows execution remains CI evidence; all Linux validation runs locally.
- The unrelated completion-heading fixture edits in `tool.test.ts` and `memory-regression.test.ts` should be reverted unless validation proves they are required.

**Architecture:** Keep the single pathname-based RunStore and existing protocol state machines. Centralize run-ID validation and capability-aware sync helpers, make regular-file fsync mandatory, preserve conservative liveness and no-replace publication, and restrict cleanup to exact protocol-owned entries.

**Tech Stack:** TypeScript, Node/Bun filesystem APIs, `bun:test`, Mise, HK, GitHub Actions.

---

## File Map

- Modify: `packages/pi-agents/src/run-store-paths.ts` — explicit-root validation and deterministic capability-probe seams.
- Modify: `packages/pi-agents/src/run-store.ts` — run-ID validation, mandatory fsync, capability-aware directory sync, lock/claim portability, liveness, contention, and exact cleanup.
- Modify: `packages/pi-agents/src/artifact-store.ts` — propagated directory-fsync capability and writer-exact staging cleanup.
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts` — shared artifact limit and canonical lowercase digest validation.
- Modify: `packages/pi-agents/tests/run-store-paths.test.ts` — root and probe failure coverage.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — validation, durability, claims, liveness, cleanup, and removal of retired hostile-path tests.
- Modify: `packages/pi-agents/tests/run-store-cross-platform.test.ts` — portable child-process concurrency and crash recovery.
- Modify: `packages/pi-agents/tests/artifact-store.test.ts` — concurrent publication, directory-sync failures, and staging isolation.
- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts` — canonical digest/size coverage and removal of retired hostile-path tests.
- Modify: `packages/pi-agents/tests/tool.test.ts` — revert unrelated completion-heading fixtures.
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` — revert unrelated completion-heading fixtures.
- Modify: `packages/pi-agents/README.md` — correct explicit empty-root behavior.
- Modify: `packages/pi-agents/docs/reference.md` — distinguish explicit empty roots from empty environment overrides.
- Audit only: `.github/workflows/pr.yml` — retain the already-added native CI jobs without repair-round changes.

## Tasks

### Task 1: Restore Scope and Root/Capability Semantics

**Outcome:** Unrelated fixtures are restored, explicit empty roots fail, and capability failures are deterministically tested.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/src/run-store-paths.ts`
- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/tests/run-store-paths.test.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/reference.md`

**Steps:**

- [ ] Revert only the completion-heading additions in the two unrelated test files.
- [ ] Distinguish omitted `rootDir` from explicitly supplied empty `rootDir`; throw `run_store_error` before filesystem initialization for the latter.
- [ ] Continue ignoring empty `PI_AGENTS_RUNS_DIR` without trimming non-empty values.
- [ ] Add narrow injected filesystem seams for regular-file fsync, hard-link publication, directory-fsync, and exact cleanup failures; production defaults remain real `node:fs` operations.
- [ ] Cover mandatory file-fsync failure, hard-link failure, occupied destination behavior, optional directory-fsync codes, unexpected directory-fsync errors, and cleanup errors.
- [ ] Make the live default-root assertion platform-aware while retaining the injected host-independent matrix.
- [ ] Correct README/reference wording for explicit empty roots.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store-paths.test.ts tests/run-store.test.ts tests/tool.test.ts tests/memory-regression.test.ts`
- Expected: All suites pass and explicit empty roots never fall back.

### Task 2: Enforce Run-ID Containment and Mandatory File fsync

**Outcome:** No public API joins an invalid run ID, and every durable regular-file publication propagates fsync failure.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify: `packages/pi-agents/tests/run-store-cross-platform.test.ts`

**Steps:**

- [ ] Add one central throwing run-ID validator and call it before `path.join`, queue selection, directory creation, or file access.
- [ ] Apply it to `getRunDir`, `getRun`, update/event/artifact methods, claims, release/abandon, and claim inspection while preserving each API's established error shape.
- [ ] Prevent event append from creating a missing or invalid run directory.
- [ ] Remove best-effort regular-file fsync; use one failure-propagating helper for run snapshots, events, lock owners/intents, claim owners, and terminals.
- [ ] Add a narrow fsync test seam and tests proving failures propagate without successful publication.
- [ ] Exercise empty, traversal, slash, backslash, absolute, and drive-like IDs across public APIs; assert nothing is created outside the root.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-store-cross-platform.test.ts`
- Expected: Invalid IDs fail before filesystem access and injected file-fsync failures are observable.
- Run: `rg -n 'function fsyncFd\b|else fsyncFd\(|fsyncFd\(fd\)' packages/pi-agents/src/run-store.ts`
- Expected: No best-effort regular-file fsync remains.

### Task 3: Correct Lock and Claim Portability

**Outcome:** Lock and claim protocols honor directory-fsync capability, classify Windows contention correctly, and treat only `ESRCH` as proof of death.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify: `packages/pi-agents/tests/run-store-cross-platform.test.ts`

**Steps:**

- [ ] Remove residual lock/candidate directory-fd helpers and unconditional directory descriptor fsync.
- [ ] Route every directory sync through the probed `directoryFsync` capability; skip directory open/sync only when unsupported and propagate failures when supported.
- [ ] Preserve pathname `dev`/`ino` generation checks required for cooperative transitions.
- [ ] Make liveness return dead only for `ESRCH`; success, `EPERM`, `ENOSYS`, unknown errno, and unknown exceptions remain busy.
- [ ] Apply `isNoReplaceContentionError` to claim owner and terminal publication, using destination existence for Windows `EPERM`.
- [ ] Replace recursive claim staging cleanup with exact recognized-file unlink followed by `rmdir`; preserve unknown entries.
- [ ] Validate steal-intent owner temp names against the exact `.owner.<strict-token>.tmp` grammar through one shared helper.
- [ ] Test complete lock/claim cycles with directory fsync disabled, supported sync failure, all liveness outcomes, Windows contention classification, malformed temp names, and unknown-entry preservation.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-store-cross-platform.test.ts`
- Expected: Locking, recovery, release, and claims pass with directory sync disabled; only `ESRCH` permits abandonment.
- Run: `rg -n 'openLockDirFd|directoryFlag|fsyncFdStrict\((lockFd|candFd)|rmSync\([^\n]*recursive' packages/pi-agents/src/run-store.ts`
- Expected: No residual directory-fd sync or recursive production claim cleanup.

### Task 4: Correct Artifact Durability and Validation

**Outcome:** Artifact publication shares RunStore capability state, failures propagate correctly, and cleanup cannot remove another writer's staging file.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/artifact-store.ts`
- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Modify: `packages/pi-agents/tests/artifact-store.test.ts`
- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Pass probed directory-fsync capability into `createArtifactStore` with narrow file/directory sync test seams.
- [ ] Skip directory sync only when unsupported; otherwise surface failure as `artifact_write_error`.
- [ ] Keep regular-file fsync mandatory before rename publication.
- [ ] Clean only the current writer's exact staging pathname, then attempt non-recursive staging-directory removal; preserve unknown or competing entries.
- [ ] Add concurrent same/different artifact publication using `process.execPath`, argument arrays, barriers, and natural child exit.
- [ ] Test unknown staging preservation, directory-sync-disabled success, and supported directory-sync failure.
- [ ] Import `RUN_ARTIFACT_MAX_BYTES` in the reader; remove duplicated constants.
- [ ] Validate the original SHA-256 as lowercase hex instead of normalizing it.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/artifact-reader-extension.test.ts`
- Expected: Publication deduplicates safely, staging remains isolated, sync failures propagate, and uppercase digests are rejected.

### Task 5: Finish Portable Test Coverage and Remove Retired Tests

**Outcome:** Core supported behavior runs cross-platform without dead skipped hostile-filesystem tests.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify: `packages/pi-agents/tests/run-store-cross-platform.test.ts`
- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Replace hard-coded `bun` child spawns with `process.execPath` and argument arrays.
- [ ] Remove Windows guards from supported lock, crash, contention, and live-owner scenarios.
- [ ] Retain platform guards only for genuine POSIX-mode, external link-privilege, or Linux PID-reuse coverage.
- [ ] Prefer natural child exit after filesystem barriers instead of forced `process.exit`.
- [ ] Delete retired hostile symlink/realpath/inode/no-follow test bodies rather than retaining blanket skips.
- [ ] Retain active traversal, schema, digest, size, regular-file, corruption, containment, and error-collapse tests.
- [ ] Leave `.github/workflows/pr.yml` unchanged during this repair round.

**Validation:**

- Run: `cd packages/pi-agents && bun test`
- Expected: Full Linux package suite passes without retired hostile-path skips.
- Run: `rg -n "\b(it|test|describe)\.skip" packages/pi-agents/tests/run-store.test.ts packages/pi-agents/tests/artifact-reader-extension.test.ts`
- Expected: No matches.
- Run: `rg -n "spawn\('bun'|spawnSync\('bun'" packages/pi-agents/tests/run-store*.test.ts packages/pi-agents/tests/artifact-store.test.ts`
- Expected: No matches.

### Task 6: Audit the Incremental Repair Diff

**Outcome:** Unstaged changes contain only fixes from this plan and do not alter the staged implementation baseline outside review scope.

**Files:** All files above; no new implementation scope.

**Steps:**

- [ ] Review only `git diff` against the staged baseline; do not use `git diff HEAD` for repair-round scope decisions.
- [ ] Confirm the unstaged file list is limited to this plan's file map.
- [ ] Confirm Version 1 constants/formats, trusted-root boundary, hard-link requirement, and CI jobs remain unchanged.
- [ ] Confirm no proc-fd/no-follow architecture, recursive protocol cleanup, best-effort regular-file fsync, digest normalization, or retired hostile-path skips remain.

**Validation:**

- Run: `git diff --check`
- Expected: No whitespace errors.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run test --package packages/pi-agents`
- Expected: Complete Linux suite passes.
- Run: `mise run build --package packages/pi-agents`
- Expected: Both entry points build.
- Run: `hk check`
- Expected: Repository checks pass.

## Failure Behavior

- Invalid run IDs fail before queue/path/filesystem access.
- Explicit empty `rootDir` fails with `run_store_error`; no default or temporary fallback is used.
- Regular-file fsync failure fails the active durable operation.
- Unsupported directory fsync disables directory sync only; mandatory file fsync and hard-link publication remain required.
- Windows `EPERM` is contention only when the destination exists.
- Only `ESRCH` proves process death; indeterminate liveness remains busy.
- Cleanup removes only exact protocol-owned entries and preserves unknown/foreign entries.
- Uppercase artifact digests are invalid rather than normalized.

## Privacy and Security

The complete runs root remains trusted, application-owned per-user storage. Same-user symlink, junction, reparse-point, and pathname replacement attacks remain out of scope; ordinary API traversal, schema, token, digest, and size validation remain mandatory.

## Risks and Mitigations

- **Native errno variation:** deterministic seams verify classification; native Windows/macOS CI supplies integration evidence.
- **Directory fsync unavailable:** retain mandatory file fsync and the documented sudden-power-loss limitation.
- **Unknown protocol entries block cleanup:** preserve them intentionally rather than risking deletion of foreign data.

## Open Questions

None.
