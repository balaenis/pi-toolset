---
description: Full implementation workflow - explore analyzes, planner plans, general implements, then review until clean
---

Run a full implementation workflow as a single `agent` chain. The work is complete only when the requested change is implemented, validated, and reported.

Before running the chain, send a one-line update stating the target.

Run the chain with these steps, each later step referencing earlier output via `{outputs.<name>}`:

1. `context` (explore): Analyze and find all code and information relevant to $@.
2. `plan` (planner): Create an implementation plan for "$@" from `{outputs.context}`.
3. `implement` (general): Before applying, confirm `{outputs.plan}` actually contains an implementation plan. If it is empty, missing, or carries no concrete steps, stop and report the problem instead of proceeding. Otherwise execute `{outputs.plan}`.

Loop: run the review workflow on the result until it reports `Clean`.

The `implement` output must include:

- `## Completed`: what was done
- `## Files Changed`: files touched
- `## Validation`: commands run with pass/fail, or `Not run: <reason>`

Stop rules:

- Report a blocker, not completion, when a plan step cannot be applied safely or when validation fails without a stated reason.
- If a plan step depends on missing context or permissions, stop and report what is missing instead of guessing.
