# Cross-Platform RunStore Review Fixes Round 2 Plan

**Goal:** Resolve the remaining incremental review findings and restore a stable staged-baseline workflow without expanding implementation scope.

**Inputs:** The staged cross-platform implementation, first repair round, `2026-07-18-cross-platform-run-store-review-fixes-plan.md`, and the incremental review findings.

**Assumptions:**

- All current implementation and first-round repair changes, plus this plan, are staged before Round 2 begins.
- Round 2 changes remain unstaged until reviewed.
- Native Windows/macOS execution remains CI evidence; portable behavior must still be represented by host-independent tests.

**Architecture:** Retain the current pathname RunStore and capability model. This round fixes remaining API consistency, failure cleanup, injectable directory-sync behavior, portable tests, and standalone artifact-store capability handling.

**Tech Stack:** TypeScript, Node/Bun filesystem APIs, `bun:test`, Mise, HK.

---

## File Map

- Modify: `packages/pi-agents/src/run-store-paths.ts` — reject explicit empty roots in the exported resolver.
- Modify: `packages/pi-agents/src/run-store.ts` — clean failed claim staging and inject capability-gated directory sync.
- Modify: `packages/pi-agents/src/artifact-store.ts` — make standalone capability handling explicit and portable.
- Modify: `packages/pi-agents/tests/run-store-paths.test.ts` — separate explicit-empty-root rejection from empty-environment behavior.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — genuine lock/claim sync, cleanup, owner-temp, and Windows portability coverage.
- Modify: `packages/pi-agents/tests/run-store-cross-platform.test.ts` — natural child termination.
- Modify: `packages/pi-agents/tests/artifact-store.test.ts` — pass/probe explicit capability and cover mandatory file-fsync failure.

## Tasks

### Task 1: Restore Resolver Consistency

**Outcome:** Every public root-resolution entrypoint rejects explicitly supplied empty programmatic roots while ignoring empty environment overrides.

**Steps:**

- [ ] In `resolveRunsRoot`, distinguish an omitted `rootDir` property from `rootDir: ''` and throw actionable `run_store_error` for the latter.
- [ ] Keep non-empty root values untrimmed and relative resolution against injected/current cwd.
- [ ] Replace the existing test that expects empty programmatic root fallback with explicit rejection.
- [ ] Add a separate test proving empty `PI_AGENTS_RUNS_DIR` is ignored.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store-paths.test.ts`
- Expected: Resolver matrix passes with explicit empty rejection.

### Task 2: Clean Failed Claim Staging Exactly

**Outcome:** Owner staging failures leave no known staging residue and never remove unknown entries.

**Steps:**

- [ ] Wrap `stageOwner` publication so open/write/fsync/close failures trigger exact cleanup of only that attempt's `owner.json` and non-recursive `rmdir` of its staging directory.
- [ ] Preserve an unknown entry if present; tolerate only absent/non-empty outcomes appropriate to exact cleanup and rethrow the original durable failure.
- [ ] Inject owner-file fsync failure and assert the staging directory is absent when it contains only recognized entries.
- [ ] Add a separate direct/recovery scenario that actually invokes cleanup on a staging directory containing an unknown entry and proves preservation.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: Owner fsync failure propagates and exact cleanup assertions pass.

### Task 3: Inject and Exercise RunStore Directory Sync

**Outcome:** All capability-gated directory sync sites share one injectable implementation, and failures are tested at lock/claim publication sites.

**Steps:**

- [ ] Add one narrow `CreateRunStoreOptions` directory-sync implementation seam defaulting to strict real directory fsync.
- [ ] Route `fsyncRunDir` and every lock, candidate, intent, tombstone, claim, terminal, and cleanup directory sync through this seam when `directoryFsync` is true.
- [ ] Do not call the seam when the capability is false.
- [ ] Add deterministic tests for supported directory-sync failure during lock acquisition and claim/terminal publication; assert failure propagates and no false durable success is reported.
- [ ] Retain the existing strict-transaction-specific seams for their fault-phase semantics rather than conflating them.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-store-cross-platform.test.ts`
- Expected: Disabled directory sync cycles pass; supported failures at protocol publication sites are observable.

### Task 4: Finish Portable Lock/Crash Coverage

**Outcome:** Supported cross-platform lock, crash, contention, and child-writer tests run on Windows instead of returning early.

**Steps:**

- [ ] Inspect every remaining `if (process.platform === 'win32') return` in RunStore tests.
- [ ] Remove guards from live lock, transaction crash/recovery, contention, concurrent writer, claim, and event scenarios supported by production behavior.
- [ ] Retain guards only for POSIX permission/mode assertions, test symlink privilege, or Linux `/proc/<pid>/stat` PID-reuse behavior; add a short reason where retained.
- [ ] Replace forced child `process.exit(2)` in the cross-platform suite with thrown failure or `process.exitCode` so termination is natural.
- [ ] Keep `process.execPath` and argument arrays for all child processes.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-store-cross-platform.test.ts`
- Expected: Linux passes and portable cases contain no Windows early-return guards.
- Run: `rg -n "process\.platform === 'win32'" packages/pi-agents/tests/run-store*.test.ts`
- Expected: Every remaining match is justified by an explicitly out-of-scope platform constraint.

### Task 5: Make Standalone ArtifactStore Capability Explicit

**Outcome:** Standalone tests and child processes do not assume directory fsync support on Windows, while RunStore passes its probed capability.

**Steps:**

- [ ] Remove the implicit `directoryFsync: true` assumption from bare `createArtifactStore()` use.
- [ ] Choose an explicit API contract: require callers/tests to pass the capability, or initialize capability through an existing safe helper without duplicating weaker probing.
- [ ] Keep RunStore construction wired to its probed `RunStoreCapabilities.directoryFsync`.
- [ ] Update all standalone tests and child scripts to pass an explicit host-appropriate/probed capability.
- [ ] Add mandatory artifact regular-file fsync failure coverage and assert no destination is published and only the writer's exact staging entry is cleaned.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/artifact-store.test.ts tests/artifact-reader-extension.test.ts`
- Expected: Artifact tests pass without assuming directory fsync availability.

### Task 6: Strengthen Tests That Previously Missed the Repaired Branches

**Outcome:** Tests fail against the pre-repair behavior and directly exercise exact grammar and cleanup paths.

**Steps:**

- [ ] Replace the owner-temp test input that the old broad validator already rejected with a basename accepted by the old short `.owner.*` rule but rejected by the exact strict-token grammar.
- [ ] Ensure foreign claim staging is passed through the production cleanup/recovery path rather than merely planted beside an unrelated operation.
- [ ] Verify the new directory-sync and artifact file-fsync seams are invoked at intended publication phases.
- [ ] Keep assertions focused on public error families and exact filesystem residue.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/artifact-store.test.ts`
- Expected: Branch-specific tests pass and would regress under the previous implementation.

### Task 7: Incremental Audit and Full Validation

**Outcome:** The Round 2 unstaged diff contains only this plan's corrections and passes all Linux checks.

**Steps:**

- [ ] Review only `git diff` relative to the newly staged baseline.
- [ ] Confirm no staged changes occur during implementation.
- [ ] Confirm no unrelated docs, CI, Version 1 schema, or protocol redesign changes.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run test --package packages/pi-agents`
- Expected: Complete suite passes.
- Run: `mise run build --package packages/pi-agents`
- Expected: Both entry points build.
- Run: `hk check && git diff --check`
- Expected: Formatting/lint and whitespace checks pass.

## Failure Behavior

- Explicit empty programmatic roots fail before filesystem access.
- Claim staging fsync failures rethrow after exact best-effort cleanup of recognized entries.
- Supported directory-sync failures fail the active durable protocol operation; unsupported capability avoids directory open/sync.
- Standalone ArtifactStore callers must provide or obtain an explicit capability state; no silent strong-platform assumption is allowed.
- Unknown protocol entries remain preserved.

## Privacy and Security

The trusted per-user runs-root boundary remains unchanged. This round changes cooperative durability and portability behavior only; hostile same-user pathname mutation remains out of scope.

## Open Questions

None.
