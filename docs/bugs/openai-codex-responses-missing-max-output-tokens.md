# Bug: `openai-codex-responses` provider does not pass `max_output_tokens` to API

## Status

Open.

## Severity

Medium — causes subagent truncation during long-thinking review/gate workflows, leading to false completion-check failures and wasted retries.

---

## Summary

The `openai-codex-responses` provider in `@earendil-works/pi-ai` does not include `max_output_tokens` in the API request body. When a model engages in extended reasoning (e.g., a reviewer subagent running 42 turns of deep inspection), thinking tokens consume the server-side default output budget, and the API returns `stopReason: "length"` before the model produces any visible text output. This causes completion-check failures with misleading errors and forces unnecessary retries.

---

## Root Cause

In `openai-codex-responses.js`, the `buildRequestBody` function constructs the API payload without `max_output_tokens`:

```js
// openai-codex-responses.js — buildRequestBody
const body = {
    model: model.id,
    store: false,
    stream: true,
    instructions: ...,
    input: messages,
    text: { verbosity: ... },
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: ...,
    tool_choice: "auto",
    parallel_tool_calls: true,
    // NOTE: max_output_tokens is NOT set
};
```

By contrast, the sibling `openai-responses` provider **does** pass it:

```js
// openai-responses.js:192-193
if (options?.maxTokens) {
  params.max_output_tokens = options?.maxTokens;
}
```

The `models.json` schema supports `maxTokens` in both full model definitions and `modelOverrides`, so users can configure it — but the value is silently ignored by this provider.

### Upstream alignment

The official [openai/codex](https://github.com/openai/codex) Rust codebase also does not set `max_output_tokens` at the model-request level (searched `codex-rs/**/*.rs`). The parameter only appears in tool-level contexts (`exec_command`, `code_mode`, `shell_spec`). The official Codex CLI therefore has the same latent issue; pi's provider was implemented to match the upstream wire format but inherited the gap.

---

## Reproduced Incident

**Run:** `run-6331325f-4889-4681-8ff5-eaed25634795`
**Session:** `2026-07-16T13-26-54-329Z_019f6b1b-d679-7f7b-a323-ad73f16c5833.jsonl`
**Model:** `gpt-5.6-sol` via `openai-codex-responses` (thinking `xhigh`)

### Timeline

| Turn     | What happened                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1–41     | Reviewer inspects branch diff, plans, production code, and tests across 53 files / +8495 −1232 lines                              |
| 42       | Final thinking pass begins — model analyzes postprocessing, fanout gates, snapshot ownership, terminal cleanup, and Grok ordering |
| 42 (end) | API returns `stopReason: "length"` while model is still in thinking phase                                                         |
| Post     | Session compacted at `tokensBefore: 371,566`. No final assistant text message exists.                                             |

### Last assistant message (truncated)

```json
{
  "role": "assistant",
  "content": [
    { "type": "thinking", "thinking": "**Analyzing terminal emission delay…**" },
    { "type": "thinking", "thinking": "**Verifying ID size limits…**" }
    // … more thinking blocks …
  ],
  "stopReason": "length",
  "usage": {
    "input": 6674,
    "output": 1479,
    "cacheRead": 363008,
    "reasoning": 1436
  }
}
```

No `type: "text"` block was produced — the model never started writing the report.

### Downstream impact

1. `getFinalOutput(messages)` returns `""` (no assistant text messages)
2. `getResultOutput` returns: `"Completion check failed: missing …\n\nUnchecked agent output:\n(no output)"`
3. The parent model sees "Completion check failed" with no body, interprets it as a retryable tool failure, and reruns the full gate — wasting ~650k input tokens and 15k output tokens.

---

## Proposed Fix

In `openai-codex-responses.js`, add `max_output_tokens` to `buildRequestBody` when `options.maxTokens` is set:

```js
if (options?.maxTokens) {
  body.max_output_tokens = options.maxTokens;
}
```

Optionally, also set `reasoning.max_output_tokens` to give thinking a dedicated budget:

```js
if (options?.maxTokens && options?.reasoningEffort) {
  body.reasoning = {
    ...body.reasoning,
    max_output_tokens: Math.floor(options.maxTokens * 0.7), // 70% for thinking
  };
}
```

Users could then configure:

```json
{
  "providers": {
    "openai-codex": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "contextWindow": 272000,
          "maxTokens": 64000
        }
      }
    }
  }
}
```

The Codex backend likely supports `max_output_tokens` since it proxies to the standard OpenAI Responses API, which accepts this parameter. If the backend rejects it, the error will be clear and the parameter can be gated behind a compat flag.

---

## Affected Versions

- `@earendil-works/pi-ai` ≤ 0.79.8 (current at time of writing)

## Related

- `openai-responses` provider correctly passes `max_output_tokens` (line 192)
- `models-schema.json` already documents `maxTokens` for `modelOverrides`
- Official codex Rust codebase matches the same omission (not pi-specific)
