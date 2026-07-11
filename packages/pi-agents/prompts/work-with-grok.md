---
description: Delegate a task to the worker agent on the Grok ACP runtime (structured tool calls + usage)
---

Use the `agent` tool to delegate the following task to the `worker` agent, with the runtime overridden to Grok ACP for this call: $@

Pass these per-call overrides:

- `runtime`: `grok-acp`
- `model`: `grok-4.5`
- `thinking`: `high`

Grok ACP speaks the Agent Client Protocol over stdio. Unlike the `grok` streaming-json runtime, it exposes structured tool calls and token/cost usage on the result. Prerequisites: the Grok CLI is installed and authenticated (`grok login`, or `XAI_API_KEY` set in the environment).

The worker's final output should include `## Completed`, `## Files Changed`, and `## Validation` (commands run + pass/fail, or `Not run: <reason>`).
