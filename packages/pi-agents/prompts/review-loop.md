---
description: Closed review loop - reviewer reviews, planner plans fixes, general applies, re-review until clean
---

Use the `agent` tool with the chain parameter to execute this workflow:

1. Use the "reviewer" agent (named `review`) to review $@. It reports under `## Standards` and `## Spec`, each axis verbatim from its sub-agent, writing `- None.` under an axis with no findings, and ends with a one-line summary: per-axis finding counts and each axis's worst issue. If both axes read exactly `- None.`, the work is clean: stop and report `Clean`.
2. Before each new fix round, confirm the staged baseline: run `git status` and `git diff --cached --stat`, and verify the staged changes match the intended fix scope. Do not start a round against an unconfirmed or drift-prone baseline; if the staged set does not match the plan, stop and report it.
3. Otherwise, use the "planner" agent (named `fix`) to build a fix plan from `{outputs.review}`. Treat an axis of exactly `- None.` as "no findings" and leave it out of the plan. Every remaining finding must be addressed: fixed, or explicitly justified as out of scope.
4. Use the "general" agent (named `implement`) to apply `{outputs.fix}`. End with `## Completed`, `## Files Changed`, and `## Validation`. If a fix cannot be applied safely, stop and report the blocker instead of pretending completion.
5. Re-review the result: run the chain again with the fixed output as the new input, until step 1 clears both axes. Repeat the step 2 baseline confirmation at the start of each round.

Execute as a chain. Name each step so later steps can reference earlier outputs via `{outputs.<name>}`.
