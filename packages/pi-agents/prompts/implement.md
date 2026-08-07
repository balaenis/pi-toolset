---
description: Full implementation workflow - explore analyzes, planner plans, general implements, then review until clean
---

Use the `agent` tool with the chain parameter to execute this workflow:

1. Use the "explore" agent (named `context`) to analyze and find all code and information relevant to: $@
2. Use the "planner" agent (named `plan`) to create an implementation plan for "$@" using `{outputs.context}`.
3. Use the "general" agent (named `implement`) to execute `{outputs.plan}`. End with `## Completed`, `## Files Changed`, and `## Validation` (commands run + pass/fail, or `Not run: <reason>`).

Execute as a chain. Name each step so later steps can reference earlier outputs via `{outputs.<name>}`. The general agent's final output **must** include `## Completed`, `## Files Changed`, and `## Validation`.
