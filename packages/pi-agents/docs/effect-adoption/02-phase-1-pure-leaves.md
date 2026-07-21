# Phase 1: Pure Leaf Modules (`template`, `completion-check`)

**Goal:** Establish Effect/Either style on pure, zero-IO modules without changing call-site behavior.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md); current `template.ts`, `completion-check.ts`, and their tests.

**Assumptions:**

- Phase 0 merged (or landed on the same branch first).
- Public signatures of `renderTaskTemplate`, `validateCompletionOutput`, and `enforceCompletionCheck` stay unchanged.
- Either/Effect types may be exported as **additional** helpers; existing Result shapes remain for callers.

**Architecture:** Keep wire Result types (`TemplateResult`, `CompletionValidation`) stable. Optionally add internal `Either` helpers or dual APIs (`renderTaskTemplateEffect`) only if they reduce duplication; default is implement pure logic with `Either` internally and adapt to existing return types at the export boundary.

**Tech Stack:** `effect` (`Either` / optionally `Effect` for uniformity), existing tests.

---

## File Map

- Modify: `packages/pi-agents/src/template.ts` — Either-style implementation behind stable `renderTaskTemplate`
- Modify: `packages/pi-agents/src/completion-check.ts` — pure validation via Either or equivalent; `enforceCompletionCheck` still mutates `SingleResult` as today
- Test: `packages/pi-agents/tests/template.test.ts` — keep as oracle; add cases only if new exports appear
- Test: `packages/pi-agents/tests/completion-check.test.ts` — keep as oracle

## Out of Scope

- Changing template token syntax or artifact descriptor format
- Changing completion heading regex semantics
- Migrating `structured-output.ts`

## Tasks

### Task 1: `template.ts` Either boundary

**Outcome:** `renderTaskTemplate` behavior is identical; implementation uses `Either` (or Effect sync) for the ok/unknown branch without exporting a breaking type change.

**Files:**

- Modify: `packages/pi-agents/src/template.ts`
- Test: `packages/pi-agents/tests/template.test.ts`

**Steps:**

- [ ] Keep `TemplateResult` as the public return type (do not force callers onto `Either`).
- [ ] Optionally extract pure core:

  ```ts
  // internal or exported additive
  function renderTaskTemplateEither(
    template: string,
    context: TemplateContext
  ): Either.Either<{ text: string; requiresArtifactReader?: boolean }, string>;
  ```

  where `Left` is the unknown placeholder name.

- [ ] `renderTaskTemplate` becomes a thin adapter:

  - `Either.match` → `{ ok: true, text, requiresArtifactReader? }` / `{ ok: false, unknown }`

- [ ] Preserve `requiresArtifactReader` when `previousRef` or `textRef` descriptors are used.
- [ ] Do not change `TOKEN_RE` or `renderItem` semantics.
- [ ] If additive export is introduced, add 1–2 tests proving Either left/right mapping; otherwise rely on existing suite.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/template.test.ts`
- Expected: All existing tests pass.

### Task 2: `completion-check.ts` pure validation style

**Outcome:** `validateCompletionOutput` / `enforceCompletionCheck` behavior unchanged; pure validation path uses Either or stays Result-compatible with clearer separation.

**Files:**

- Modify: `packages/pi-agents/src/completion-check.ts`
- Test: `packages/pi-agents/tests/completion-check.test.ts`

**Steps:**

- [ ] Keep `CompletionValidation` public shape (`{ ok, missing }`).
- [ ] Optionally model pure check as:

  ```ts
  Either.Either<void, string[]>; // Right = pass, Left = missing headings
  ```

  then adapt to `CompletionValidation`.

- [ ] `enforceCompletionCheck` must still:
  - no-op when `isFailedResult(result)`
  - set `stopReason: 'completion_check'`, `status: 'failed'`, `errorMessage` with missing list
  - set `exitCode = 1` when it was `0`
- [ ] Do not change `hasHeading` regex rules.
- [ ] Avoid pulling `effect-runtime` (sync-only module).

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/completion-check.test.ts`
- Expected: Pass.

### Task 3: Call-site smoke (no production rewrites required)

**Outcome:** Confirm importers still typecheck; no forced call-site edits.

**Files:**

- None required unless type exports broke inference

**Steps:**

- [ ] Grep importers: `renderTaskTemplate` (e.g. `chain.ts`), `enforceCompletionCheck` (e.g. `tool.ts`).
- [ ] Fix only if TypeScript fails — do not opportunistically rewrite chain/tool to Either.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `cd packages/pi-agents && bun test tests/template.test.ts tests/completion-check.test.ts tests/chain.test.ts`
- Expected: Pass (chain covers template integration).

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/template.test.ts tests/completion-check.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

## Failure Behavior

- Unknown template placeholder → still `{ ok: false, unknown }` (first unknown wins, same as today).
- Missing completion headings → still mutate result to failed with `completion_check`.

## Privacy and Security

- Templates may embed task text and artifact descriptors; no new logging.

## Rollout Notes

- Pure refactor; ship anytime after Phase 0.

## Risks and Mitigations

- Over-abstracting two tiny files — if Either adds noise without clarity, keep Result types and only share patterns via comments; still mark phase complete if conventions are demonstrated and tests stay green.
- Accidental regex drift — do not “improve” heading matching in this phase.

## Open Questions

None.
