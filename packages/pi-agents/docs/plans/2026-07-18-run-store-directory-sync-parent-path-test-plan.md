# RunStore Directory Sync Parent Path Test Plan

**Goal:** Bind directory-sync phase assertions to the intended run and claims parent paths.

**Inputs:** Round 3 directory-sync tests and incremental review finding.

**Assumptions:** Production behavior is correct; only assertion precision changes.

**Architecture:** Strengthen the three existing predicates so candidate/lock sync paths must be direct children of the test run directory and claim ticket/terminal sync paths must be direct children of that run's `claims` directory.

**Tech Stack:** TypeScript, `bun:test`, `node:path`.

---

## File Map

- Modify: `packages/pi-agents/tests/run-store.test.ts` — parent-bound directory-sync assertions.

## Tasks

### Task 1: Bind Sync Paths to the Owning Run

**Outcome:** A same-shaped path under another run or root cannot satisfy the lock, claim, or terminal sync assertions.

**Steps:**

- [ ] For lock candidate/lock publication, require `path.dirname(syncPath) === runDir` in addition to exact candidate/lock basename grammar.
- [ ] For claim ticket/terminal publication, require `path.dirname(syncPath) === path.join(runDir, 'claims')` in addition to exact ticket basename grammar.
- [ ] Preserve existing phase/error/residue assertions.
- [ ] Modify no production code or unrelated test.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: RunStore suite passes.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `git diff --check`
- Expected: No whitespace errors.

## Failure Behavior

A sync callback for another run/root must not satisfy the intended protocol-phase assertion.

## Privacy and Security

No production or trust-boundary changes.

## Open Questions

None.
