---
description: Implementation workflow starting from an existing plan, with TDD and a closed review loop
---

Run an implementation workflow from an existing plan as a single `agent` chain. The work is complete only when the plan is implemented, validated, and the review loop clears both axes.

Before running the chain, send a one-line update stating the target.

Run the chain with these steps, each later step referencing earlier output via `{outputs.<name>}`:

1. `implement` (general): Confirm `$@` actually contains an implementation plan. If it is empty, missing, or contains no concrete steps, stop and report the problem instead of proceeding. Otherwise apply the plan via TDD: write failing tests, make them pass, then refactor.
2. `review` (reviewer): Review the implementation. Report under `## Standards` and `## Spec`, writing `- None.` under an axis with no findings. If both axes read exactly `- None.`, stop and report `Clean`.
3. `fix-plan` (planner): Build a fix plan from `{outputs.review}`. Address every remaining finding: fix it, or explicitly justify it as out of scope.
4. `fix` (general): Before applying, confirm `{outputs.fix-plan}` actually contains a fix plan. If it is empty, missing, or carries no concrete fixes, stop and report the problem. Otherwise stage existing changes to confirm the baseline for the next review, then apply.

Loop: after step 1 completes, re-run steps 2–4 with the fixed implementation as the new input until the review clears both axes.

Success criteria:

- The plan is implemented and validated: relevant tests pass, plus type checks and lint where applicable.
- Both `## Standards` and `## Spec` report `- None.`

Stop rules:

- Report `Clean` the moment a review clears both axes.
- Report a blocker, never fake completion, when a plan step cannot be applied safely or validation fails without a stated reason.
- If a plan step depends on missing context or permissions, stop and report what is missing instead of guessing.
- If a re-review round produces no new fix and no new blocker, stop and report the outstanding findings and the blocker map.
