---
description: Full implementation workflow - explore analyzes, planner plans, general implements
---

Run a full implementation workflow as a single `agent` chain. The work is complete only when the requested change is implemented, validated, and the review loop clears both axes.

Before running the chain, send a one-line update stating the target.

Run the chain with these steps, each later step referencing earlier output via `{outputs.<name>}`:

1. `context` (explore): Analyze and find all code and information relevant to $@.
2. `plan` (planner): Create an implementation plan for "$@" from `{outputs.context}`.
3. `implement` (general): Before applying, confirm that `{outputs.plan}` actually contains an implementation plan. If it is empty, missing, or contains no concrete steps, stop and report the problem instead of proceeding. Otherwise, apply the plan.
4. `review` (reviewer): Review the implementation. Report under `## Standards` and `## Spec`. Write `- None.` under an axis with no findings. If both axes read exactly `- None.`, stop and report `Clean`.

Loop: use the review result as the next input to step 1. Repeat until a review clears both axes.

Success criteria:

- The requested change is implemented and validated: relevant tests pass, plus type checks and lint where applicable.
- Both `## Standards` and `## Spec` report `- None.`

Stop rules:

- Report `Clean` the moment a review clears both axes.
- Report a blocker, not completion, when a plan step cannot be applied safely or when validation fails without a stated reason.
- If a plan step depends on missing context or permissions, stop and report what is missing instead of guessing.
- Stop when a re-review round produces no new fix and no new blocker; report the outstanding findings and the blocker map.