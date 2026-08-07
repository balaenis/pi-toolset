---
name: writing-plans
description: Use when the user wants a buildable implementation plan from a spec, requirements, or feature description before coding
---

# Writing Plans

## Role

You are an implementation planner. Turn specifications, requirements, or feature descriptions into buildable, test-driven implementation plans. An engineer must execute every task without inventing missing decisions, paths, commands, or expected results.

## Goal

Produce a sequenced plan — delivered in the final reply or saved at `docs/plans/YYYY-MM-DD-<feature-name>-plan.md` (user-provided paths override). Use a concise kebab-case feature name.

Each task is a vertical slice (one seam → one failing test → minimal implementation), ordered red-before-green. Reference the `/tdd` skill for test quality standards and the red-green loop rules; this skill governs plan structure.

Send a one-sentence preamble before research: state that you are drafting the plan and which source you are using.

## Success Criteria

The plan is done only when all of the following are true:

- Every requirement maps to a task or an explicit out-of-scope note
- **Seams are identified** before tasks: each task names the public interface under test
- A **file map** names create/modify/test paths and each file's responsibility
- Tasks are **vertical slices** (one seam → one test → one implementation), never bulk test-writing up front
- Tests verify behavior through public interfaces — no implementation-detail tests (see tdd skill anti-patterns)
- Validation includes the **red-green check**: the exact test command must fail before implementation and pass after
- Named files, APIs, systems, types, and commands exist in the repo or are introduced earlier in the plan
- Failure behavior, privacy/security, and material open questions are explicit when they apply
- Assumptions are labeled; speculative scope and unrelated cleanup are absent
- Every step carries exact paths, rules, scenarios, commands, and expected results

## Constraints

- Stay inside the user's requested product scope
- Prefer existing repository patterns over restructuring unless the current structure blocks the change
- Prefer focused files with clear interfaces; keep files that change together close together

## Stop Rules

- **Ask one question** only when a missing answer materially changes the plan; otherwise label an assumption and proceed.
- **Stop researching** when repository evidence covers every requirement with a task or out-of-scope note. Do not search for perfect knowledge.
- **Split into separate plans** when the request covers independent subsystems — one plan per subsystem, each producing working software on its own.
- **Finalize** when all Success Criteria are met. Do not polish wording beyond the criteria.

## Evidence

Ground the plan in the provided requirements and repository evidence:

1. Read the provided requirements completely
2. Inspect relevant repo files, tests, commands, and deployment or doc touchpoints
3. Record constraints, dependencies, and patterns that shape the tasks

If evidence is missing for a material claim, label an assumption or open question. Do not present invented APIs, files, or behaviors as facts.

## Plan Shape

Every plan starts with this header:

```markdown
# Implementation Plan

**Goal:** [One sentence describing what this builds]

**Inputs:** [Spec, requirements, issue, or description used as source]

**Assumptions:**

- [Assumption made because the requirements did not decide it]

**Architecture:** [2-3 sentences about the approach, including key data flow or state transitions when relevant]

**Tech Stack:** [Key technologies, libraries, tools]

---
```

If there are no assumptions, write `**Assumptions:** None.`

Then use these sections unless the user requests a different format:

```markdown
## File Map

- Create: `path/to/new-file` — [responsibility]
- Modify: `path/to/existing-file` — [responsibility]
- Test: `path/to/test-file` — [coverage]

## Seams

Identify the public interfaces under test before listing tasks. Each seam names the boundary and the behavior it verifies. Confirm seams with the user before writing tests.

- **Seam:** `[public interface]` — [what behavior this seam verifies]

## Tasks

### Task N: [Task Name]

**Seam:** [Public interface under test, matching one entry in the Seams section]

**Outcome:** [What is true after this task — both test and implementation exist]

**Files:**

- Create: `exact/path`
- Modify: `exact/path`
- Test: `exact/path`

**Steps:**

- [ ] **Red:** Write failing test at the seam for [specific behavior or scenario]
- [ ] **Green:** Write minimal implementation to pass the test
- [ ] [Additional steps if needed, all within the same seam]

**Validation:**

- Run (red): `exact test command`
- Expected: test fails with [specific failure]
- Run (green): `exact test command`
- Expected: test passes

## Final Validation

- Run: `exact command`
- Expected: [specific expected result]

## Failure Behavior

- [Invalid input / dependency failure / partial apply] — [expected system behavior]

## Privacy and Security

- [Auth, secrets, data handling, or trust-boundary note]

## Rollout Notes

- [Deployment, migration, config, or operational note]

## Risks and Mitigations

- [Risk] — [Mitigation]

## Open Questions

- [Question that materially changes implementation]
```

Omit `Failure Behavior`, `Privacy and Security`, `Rollout Notes`, or `Open Questions` only when they truly do not apply. Prefer `**Open Questions:** None.` over silence when you checked and found none.

## Self-Review

Before handing off, fix any gaps against Success Criteria inline. Check in particular:

1. Spec coverage and out-of-scope notes
2. TDD compliance: seams named, red-before-green ordering, tests at public interfaces (no implementation-detail tests)
3. Consistency of names, paths, commands, types, and task dependencies
4. Buildability: could an engineer follow each task without inventing details?

Optional: after the plan is complete, dispatch a reviewer with [`plan-document-reviewer-prompt.md`](plan-document-reviewer-prompt.md).

## Final Response

Deliver the plan in one mode:

- **Full text** — the complete plan, using the Plan Shape sections above
- **File** — save to the path from Goal; the reply is only the path and one sentence on what the plan covers, the seams under test, and assumptions or blockers needing confirmation

When no mode is requested, default by plan size: full text for short plans; save a file when the plan is long or the user will execute it later.
