# `agent_job` OpenAI-compatible schema rejection

## Summary

OpenCode Go rejects requests that include the `agent_job` tool with HTTP 400:

```text
Error from provider (Console Go): Upstream request failed
```

The same model, API key, reasoning level, and prompt succeed when `agent_job` is removed. This is not a third-party client restriction and is unrelated to DeepSeek's `thinking` request field.

## Environment

- `@balaenis/pi-agents`
- `@earendil-works/pi-coding-agent` 0.80.6
- Provider: `opencode-go`
- Model: `deepseek-v4-pro`
- API: OpenAI-compatible chat completions

## Root cause

`JobParams` used a TypeBox discriminated union:

```ts
Type.Union([
  Type.Object({ action: Type.Literal('list'), ... }),
  Type.Object({ action: Type.Literal('get'), ... }),
  Type.Object({ action: Type.Literal('resume'), ... }),
])
```

TypeBox serializes this as a top-level JSON Schema `anyOf`. The OpenCode Go upstream rejects function-tool parameter schemas with a top-level `anyOf`.

A/B tests confirmed:

- Built-in tools only: HTTP 200
- Built-in tools plus `agent_job`: HTTP 400
- Other complex tools (`agent`, `todo`, `grep`, `find`) tested individually: HTTP 200

## Fix

Replace the union with a single object schema:

- `action` remains required and enumerates `list`, `get`, and `resume`.
- `runId`, `status`, `limit`, and `allowReplay` are optional at the provider-schema level.
- The execution layer explicitly requires `runId` for `get` and `resume`.

This produces the broadly supported shape:

```json
{
  "type": "object",
  "required": ["action"],
  "properties": {
    "action": { "type": "string", "enum": ["list", "get", "resume"] },
    "runId": { "type": "string" },
    "status": { "type": "string" },
    "limit": { "type": "integer" },
    "allowReplay": { "type": "boolean" }
  }
}
```

## Verification

- Targeted schema and execution tests: 9 passed
- Full `packages/pi-agents` test suite: 733 passed, 0 failed
- Package TypeScript check: passed
- Package build: passed
- Real OpenCode Go request with the fixed source extension and `agent_job`: HTTP 200
