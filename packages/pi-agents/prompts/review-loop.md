---
description: Closed review loop - reviewer reviews, planner plans fixes, general applies, re-review until clean
---

Run a closed review loop as a single `agent` chain. The loop is complete only when both `## Standards` and `## Spec` axes report `- None.`

Before running the chain, send a one-line update stating the review target.

Each chain round contains exactly these 3 steps, each later step referencing earlier output via `{outputs.<name>}`. A new chain round starts only after the current round finishes:

1. `review` (reviewer): Review $@. Report under `## Standards` and `## Spec`, each axis verbatim from its sub-agent, writing `- None.` under an axis with no findings. End with one line: per-axis finding counts and each axis's worst issue. If both axes read exactly `- None.`, stop and report `Clean`.
2. `fix` (planner): Build a fix plan from `{outputs.review}`. Address every remaining finding: fix it, or explicitly justify it as out of scope.
3. `implement` (general): Confirm `{outputs.fix}` holds concrete fixes; else stop and report. Fix the baseline before each fix round: `git add` the working tree and verify the staged set is unchanged. Apply the fixes. Keep the baseline staged; review inspects only unstaged changes relative to it.

Loop: re-run the same 3-step chain, using the review result as the next input until a review clears both axes.

Stop rules:

- Report `Clean` the moment a review clears both axes.
- Report a blocker, never fake completion, when a fix cannot be applied safely.
- If a re-review round produces no new fix and no new blocker, stop and report the outstanding findings and the blocker map.
