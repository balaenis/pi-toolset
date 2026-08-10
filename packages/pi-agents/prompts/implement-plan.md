---
description: implement workflow - implement a plan, validate, review, fix until clean
---

Run the implementation workflow from an existing plan as a single `agent` chain, organized in rounds. Each round establishes a review baseline, implements the plan, reviews only the unstaged result, and builds a fix plan. Re-run the chain until a review clears both axes.

Send a one-line update stating the target before you run the chain. No other preamble.

Run these steps in order. Each later step reads earlier output via `{outputs.<name>}`:

1. `implement` (general): Confirm `$@` holds a concrete plan; else stop and report. Establish the review baseline before applying: `git add` the working tree and verify the staged set is unchanged. 
2. `review` (reviewer): Review the unstaged implementation relative to the baseline. Report under `## Standards` and `## Spec`. Write `- None.` under an axis with no findings. If both axes read exactly `- None.`, stop and report `Clean`.
3. `fix-plan` (planner): Build a fix plan from `{outputs.review}`. Address every finding: fix it, or justify it as out of scope. If the review is missing or has no findings, stop and report the problem.

Loop: re-run the chain with the fix plan as the next input — a new round that re-establishes the baseline — until a review clears both axes.

Success criteria:

- The plan is implemented and validated: relevant tests pass, plus type checks and lint where applicable.
- Both `## Standards` and `## Spec` report `- None.`

Stop rules:

- Report `Clean` the moment a review clears both axes.
- Report a blocker, never fake completion, when a plan step cannot be applied safely or validation fails without a stated reason.
- Stop and report missing context or permissions instead of guessing when a plan step depends on them.
- Stop when a re-review round produces no new fix and no new blocker; report the outstanding findings and the blocker map.
