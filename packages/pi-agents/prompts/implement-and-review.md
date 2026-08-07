---
description: General implements, reviewer reviews, general applies feedback
---

Use the `agent` tool with the chain parameter to execute this workflow:

1. First, use the "general" agent (named `implementation`) to implement: $@. Output must include `## Completed`, `## Files Changed`, and `## Validation`.
2. Then, use the "reviewer" agent (named `review`) to review `{outputs.implementation}`. The reviewer reports under `## Standards` and `## Spec`, each axis verbatim from its sub-agent, writing `- None.` under an axis when it has no findings, and ends with a one-line summary: per-axis finding counts and each axis's worst issue.
3. Finally, use the "general" agent to address `{outputs.review}`. The general agent must:
   - Treat an axis consisting of exactly `- None.` as “no findings” and proceed without manufacturing fixes.
   - Otherwise, resolve every finding in both axes: fix it, or explicitly justify deferral.
   - If any finding cannot be fixed safely, stop and report the blocker instead of pretending completion.
   - End with `## Completed`, `## Files Changed`, and `## Validation`.

Execute as a chain. Name each step so later steps can reference earlier outputs via `{outputs.<name>}`.
