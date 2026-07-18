# Cross-Platform RunStore Review Fixes Round 3 Plan

**Goal:** Make the full package suite green and correct the remaining portable test branches without changing production protocol behavior.

**Inputs:** Round 2 Tasks 4–6 implementation, its incremental review, and full-suite logs showing 13 baseline completion-check failures.

**Assumptions:**

- Validation now proves the completion-heading fixture changes in `tool.test.ts` and `memory-regression.test.ts` are required; restoring them is in scope.
- ArtifactStore source changes from Round 2 are accepted; this round focuses on tests and fixtures.
- Current state and this plan are staged before implementation; Round 3 remains unstaged until reviewed.

**Architecture:** Preserve production code. Make child invocation portable, retire out-of-scope hostile-path tests, mirror production process identity in fixtures, and make recovery/sync assertions enter and identify the intended protocol branches.

**Tech Stack:** TypeScript, `bun:test`, Node/Bun child processes, Mise, HK.

---

## File Map

- Modify: `packages/pi-agents/tests/tool.test.ts` — restore required completion headings in oversized fixtures.
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` — restore required completion headings in oversized fixtures.
- Modify: `packages/pi-agents/tests/run-store.test.ts` — portable child executable, retire hostile tests, robust process-start fixture, real recovery identities, exact directory-sync phase assertions.

## Tasks

### Task 1: Restore Completion-Check-Compatible Fixtures

**Outcome:** Full-suite orchestration and memory tests satisfy the current agent completion contract without weakening assertions.

**Steps:**

- [ ] Restore the minimal `## Completed`, `## Files Changed`, and `## Validation` headings to oversized fixture payloads at every failure site proven by the full-suite logs.
- [ ] Preserve sentinel placement, payload size, truncation/memory behavior, and all existing assertions.
- [ ] Do not change production completion-check logic.
- [ ] Run both suites directly and record pass counts.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/tool.test.ts tests/memory-regression.test.ts`
- Expected: Both suites pass with no `completion_check` failures.

### Task 2: Finish Portable Child and Hostile-Test Cleanup

**Outcome:** Supported tests use the running executable on every platform and out-of-scope hostile-path tests no longer create Windows guards.

**Steps:**

- [ ] Replace both literal `spawn('bun', ...)` child-writer calls with `spawn(process.execPath, [...])`.
- [ ] Delete the committed-marker symlink sabotage test and run-directory symlink replacement test rather than guarding them.
- [ ] Split the mixed wrong-token tombstone/live-candidate test: remove only symlink-specific setup/assertions and keep portable candidate/tombstone behavior active on Windows.
- [ ] Retain only the POSIX-mode guard, with a reason.
- [ ] Confirm no hard-coded Bun child spawn remains in RunStore/artifact tests.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-store-cross-platform.test.ts`
- Expected: RunStore suites pass.
- Run: `rg -n "spawn\('bun'|spawnSync\('bun'" packages/pi-agents/tests/run-store*.test.ts packages/pi-agents/tests/artifact-store.test.ts`
- Expected: No matches.
- Run: `rg -n "process\.platform === 'win32'" packages/pi-agents/tests/run-store*.test.ts`
- Expected: Only the documented POSIX-mode guard remains.

### Task 3: Mirror Production Process-Start Fallback

**Outcome:** Test owner identities match production on readable, unreadable, and malformed Linux `/proc` state and on non-Linux hosts.

**Steps:**

- [ ] Refactor the test helper and embedded child copies to use the production parse/fallback algorithm: read `/proc/<pid>/stat`, locate the final `)`, parse field 22, accept only decimal starttime, and catch all errors.
- [ ] Return `unsupported-<platform>-<pid>` whenever identity cannot be proven.
- [ ] Keep Linux PID-reuse-only tests scoped to Linux.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: Live/dead owner tests pass with production-equivalent identities.

### Task 4: Make Recovery and Sync Tests Branch-Exact

**Outcome:** Tests fail under the prior broad validator and broad path assertions, while passing only when repaired branches execute.

**Steps:**

- [ ] In the malformed owner-temp steal-intent fixture, derive real `dev`/`ino`, digest, and byte counts from the created lock owner/temp files before writing the intent.
- [ ] Use `.owner.bad.dots.tmp` or another basename accepted by the former broad `.owner.*.tmp` rule but rejected by the exact strict-token grammar.
- [ ] Assert the repaired implementation rejects/preserves state for the intended grammar reason after all other recovery preconditions match.
- [ ] Replace `p.includes(runId)` directory-sync assertions with exact basename/path-shape checks for candidate/lock publication and claim ticket/terminal publication.
- [ ] Keep error-family and residue assertions precise.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: Branch-exact recovery and sync tests pass.

### Task 5: Full Validation and Incremental Audit

**Outcome:** Round 3 is green and limited to the three test files in this plan.

**Steps:**

- [ ] Review only unstaged changes relative to the new staged baseline.
- [ ] Confirm no production, docs, workflow, schema, or protocol files changed.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run test --package packages/pi-agents`
- Expected: Complete package suite exits zero.
- Run: `mise run build --package packages/pi-agents`
- Expected: Both entry points build.
- Run: `hk check && git diff --check`
- Expected: All checks pass.

## Failure Behavior

A fixture that lacks the completion contract, invokes an unavailable executable, fails to construct valid recovery preconditions, or syncs an unexpected path must fail its targeted test rather than being skipped or accepted by a broad assertion.

## Privacy and Security

No production or trusted-runs threat-boundary behavior changes. Hostile same-user symlink/path-replacement tests are removed consistently with the accepted out-of-scope model.

## Open Questions

None.
