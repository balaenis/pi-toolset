# Phase 4: Worktree Result Paths

**Goal:** Align `worktree.ts` open/create/remove and status helpers with Either/Effect style while preserving git CLI behavior and existing Result unions.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md), [02-phase-1-pure-leaves.md](./02-phase-1-pure-leaves.md); `packages/pi-agents/src/worktree.ts`; `packages/pi-agents/tests/worktree.test.ts`; callers in `tool.ts`, `interactive-agent.ts`.

**Assumptions:**

- Phases 0–1 done (Either style established).
- Public functions remain sync (current module is largely sync `spawnSync`-style or equivalent — verify in file before coding).
- No automatic worktree cleanup Scope wired into `tool.ts` in this phase (that would expand scope into execution). Optional internal `acquireRelease` helper may exist but must not change callers yet.

**Architecture:** Model fallible git operations as `Either`/`Effect` with stable adapter to existing `{ ok: true/false }` unions (`OpenWorktreeResult`, dirty/diff/setup results, `RemoveWorktreeResult`). Keep path safety checks (`isUnderWorktreesDir`) pure.

**Tech Stack:** `effect` (`Either` / sync `Effect`), existing git test fixtures in `worktree.test.ts`.

---

## File Map

- Modify: `packages/pi-agents/src/worktree.ts` — Either/Effect internals; stable exports
- Test: `packages/pi-agents/tests/worktree.test.ts` — oracle
- Callers (`tool.ts`, `interactive-agent.ts`) — no changes expected

## Behavioral Invariants

1. `getGitRoot` returns repo root or `undefined` (no throw for non-git).
2. `createAgentWorktree` creates under repo `.worktrees/` with safe name.
3. `openAgentWorktree` rejects paths outside worktrees dir with `code: 'worktree_unavailable'`.
4. Dirty/diff/setup helpers return structured ok/false results (not throws) per current API.
5. `removeAgentWorktree` best-effort removal with structured result.
6. No change to worktree path naming scheme.

## Tasks

### Task 1: Inventory sync vs async and Result unions

**Outcome:** Implementer knows which functions are pure adapters vs git side effects.

**Files:**

- Read: `packages/pi-agents/src/worktree.ts`

**Steps:**

- [ ] List each export and its success/failure shape.
- [ ] Confirm tests cover: non-git cwd, open outside dir, create/remove roundtrip, setup hook failure.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/worktree.test.ts`
- Expected: Baseline green before edits.

### Task 2: Either/Effect internals with stable adapters

**Outcome:** Implementation uses Effect/Either without breaking Result unions.

**Files:**

- Modify: `packages/pi-agents/src/worktree.ts`
- Test: `packages/pi-agents/tests/worktree.test.ts`

**Steps:**

- [ ] For each fallible helper, implement core as `Either` or sync `Effect` failing with `{ error: string; code?: ... }` matching current fields.
- [ ] Public functions adapt to existing types, e.g. `OpenWorktreeResult`.
- [ ] Do not change git CLI flags/args unless a test proves they are wrong (out of scope to “fix” git UX here).
- [ ] Optional: export additive `openAgentWorktreeEither` only if useful to Phase 5+; default **no** additive export.
- [ ] Do **not** wire `Scope` into `tool.ts` in this phase.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/worktree.test.ts`
- Expected: Pass.

### Task 3: Caller typecheck smoke

**Outcome:** Tool/interactive still compile and worktree-related tool tests pass if present.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `cd packages/pi-agents && bun test tests/worktree.test.ts`
- Expected: Pass.
- Optional: `bun test tests/tool.test.ts -t "worktree"` (if such filters exist) — Expected: Pass or no matching tests.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/worktree.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

## Failure Behavior

- Invalid open path → `{ ok: false, code: 'worktree_unavailable', error }` (exact field names per current type).
- Setup hook failure → structured setup error fields; do not throw unless current code throws (preserve).

## Privacy and Security

- Worktree paths are local filesystem; setup hooks are trusted agent config (unchanged security model).

## Rollout Notes

- Internal refactor; no README change.

## Risks and Mitigations

- Accidental async conversion breaking sync callers — keep function signatures sync if currently sync.
- Scope creep into tool lifecycle — forbid in this phase.

## Open Questions

None.
