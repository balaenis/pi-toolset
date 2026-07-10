# Plan: Grok Build CLI Runtime for pi-agents

## Summary

Add `grok` as an alternative subagent runtime alongside `pi` in `@balaenis/pi-agents`. When an agent definition selects `runtime: "grok"`, the package spawns `grok` CLI (headless) instead of `pi` to execute the task, translating agent configuration and parsing Grok's output back into the existing `SingleResult` contract.

## Motivation

- Grok Build CLI supports headless mode (`grok -p`, `--output-format streaming-json`, `--always-approve`) — same execution pattern pi-agents already uses for `pi`
- Let users choose which AI runtime handles specific subagent types (e.g. code review by Grok, exploration by pi)
- xAI models (Grok 4.5, etc.) may offer different cost/quality trade-offs

## Architecture

```
AgentConfig { runtime: "pi" | "grok" }
         │
         ▼
  runSingleAgent()  ──runtime?──► grok spawn path
         │                              │
    buildPiArgs()              buildGrokArgs()
    spawn("pi", ...)           spawn("grok", ...)
         │                              │
    parsePiStream()           parseGrokStream()
         │                              │
         └────── SingleResult ◄─────────┘
```

The seam is `execution.ts` `runSingleAgent()`: it already takes `AgentConfig`, calls `buildPiArgs()` + inline stream parsing. We fork on `agent.runtime` to use Grok-specific argument builder (`buildGrokArgs`) and stream parser (`parseGrokEvent`). No temp files for Grok - system prompt passed as inline `--rules` text.

## Grok CLI Headless Reference

From https://docs.x.ai/build/cli/reference and https://docs.x.ai/build/cli/headless-scripting:

| Grok flag                         | pi-agents equivalent             | Notes                        |
| --------------------------------- | -------------------------------- | ---------------------------- |
| `-p, --single <PROMPT>`           | `-p "Task: ..."`                 | Headless prompt              |
| `-m, --model <MODEL>`             | `--model`                        | Model selection              |
| `--effort <LEVEL>`                | `--thinking`                     | Reasoning effort             |
| `--output-format streaming-json`  | `--mode json`                    | NDJSON events                |
| `--always-approve`                | implicit in json mode            | Auto-approve tools           |
| `--cwd <PATH>`                    | spawn `cwd` option               | Working directory            |
| `--max-turns <N>`                 | `agent.maxTurns`                 | Turn limit                   |
| `--rules <TEXT>`                  | system prompt append             | Extra rules                  |
| `--system-prompt-override <TEXT>` | `--system-prompt` (replace mode) | Replace system prompt        |
| `--tools <LIST>`                  | `--tools`                        | Allowed tools                |
| `--disallowed-tools <LIST>`       | `--exclude-tools`                | Denied tools                 |
| `--no-subagents`                  | `--exclude-tools agent`          | Disable subagent delegation  |
| `--no-plan`                       | N/A                              | Disable planning             |
| `--no-memory`                     | `--no-session`                   | Disable cross-session memory |
| `--session-id <UUID>`             | `--session`                      | Named session                |
| `--no-auto-update`                | N/A                              | Suppress update checks (CI)  |
| `--sandbox <PROFILE>`             | N/A                              | Sandbox profile              |
| `--allow <RULE>`, `--deny <RULE>` | N/A                              | Permission rules             |

Use Grok **native flags** (not Claude Code aliases). Empirically verified that aliases like `--append-system-prompt` take inline text, not file paths (see Empirical Findings).

## Design Decisions

### Decision 1: Use `grok -p --output-format streaming-json` (not ACP)

**Chosen**: Simple spawn + NDJSON parsing, matching the existing `pi --mode json` pattern.

**Alternative**: `grok agent stdio` (ACP / JSON-RPC over stdin/stdout). More structured protocol with session management, but:

- Requires implementing a JSON-RPC client with request/response matching
- Session lifecycle management is more complex
- Overkill for a one-shot "send task, get result" workflow

### Decision 2: New `AgentConfig.runtime` field

```typescript
runtime?: 'pi' | 'grok';  // default: 'pi'
```

Set in agent Markdown frontmatter. Backward-compatible: absent = `'pi'`.

### Decision 3: Grok-specific files, not inline branches

Dedicated `grok-invocation.ts` and `grok-parser.ts` for clean separation. `execution.ts` gets a single `if (agent.runtime === 'grok')` dispatch.

### Decision 4: System prompt via inline text (not temp file)

**Empirically verified**: Grok's `--rules <TEXT>` and `--system-prompt-override <TEXT>` take **inline text**, not file paths. Passing a file path (like pi's `--append-system-prompt <FILE>`) silently fails - the path string is treated as literal text.

```bash
# Does NOT work - path treated as literal string
grok --append-system-prompt /tmp/prompt.md -p "respond"   # ignored

# Works - inline text
grok --rules "You are a test agent. Respond with: OK" -p "respond"   # -> "OK"
```

Mapping:

- `systemPromptMode: 'append'` (default) -> `--rules <inline text>`
- `systemPromptMode: 'replace'` -> `--system-prompt-override <inline text>`

No temp file needed. Command-line arg length limit on Linux is ~128KB per arg (MAX_ARG_STRLEN); agent system prompts are typically a few KB, so this is safe.

**Caveat**: `--system-prompt-override` (replace mode) empirically does not fully suppress Grok's default behavior - project-level `.grok/` config and context files may still influence output. Prefer `--rules` (append mode) unless full replacement is explicitly required.

## Implementation Plan

### Phase 1: AgentConfig extension

**File**: `packages/pi-agents/src/agents.ts`

- Add `runtime?: 'pi' | 'grok'` to `AgentConfig` interface
- Parse `frontmatter.runtime` in `loadAgentFromFile()`, validate enum

### Phase 2: Grok argument builder

**New file**: `packages/pi-agents/src/grok-invocation.ts`

```typescript
export interface BuildGrokArgsOptions {
  disableAgentTool?: boolean;
  resolvedSkillPaths?: string[];
}

export function buildGrokArgs(
  agent: AgentConfig,
  task: string,
  options: BuildGrokArgsOptions
): string[];

export function getGrokInvocation(args: string[]): { command: string; args: string[] };
```

Mapping logic:

| AgentConfig field                   | Grok CLI flag                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.model`                       | `--model <value>`                                                                                                                                 |
| `agent.thinking`                    | `--effort <value>` (see thinking->effort mapping below)                                                                                           |
| `agent.maxTurns`                    | `--max-turns <value>`                                                                                                                             |
| `agent.systemPrompt` (append mode)  | `--rules <inline text>`                                                                                                                           |
| `agent.systemPrompt` (replace mode) | `--system-prompt-override <inline text>` (caveat: may not fully suppress defaults)                                                                |
| `agent.tools`                       | `--tools <csv>` (see tool name compatibility below)                                                                                               |
| `agent.excludeTools`                | `--disallowed-tools <csv>` (see tool name compatibility below)                                                                                    |
| `agent.noContextFiles`              | (no direct equivalent - skip; Grok has its own context gathering)                                                                                 |
| `agent.noSkills`                    | (no direct equivalent - Grok has its own skill discovery)                                                                                         |
| `options.resolvedSkillPaths`        | (no-op for Grok; pi skills are not translatable)                                                                                                  |
| `options.disableAgentTool`          | `--no-subagents`                                                                                                                                  |
| hardcoded                           | `--no-auto-update`, `--always-approve`, `--output-format streaming-json`, `--no-memory`, `-p "Task: <task>"`, `--cwd <value>` (set via spawn cwd) |

**thinking -> effort mapping** (pi has 7 levels, Grok has 3):

| pi `--thinking` | Grok `--effort` | Notes                          |
| --------------- | --------------- | ------------------------------ |
| `off`           | (omit flag)     | No reasoning                   |
| `minimal`       | `low`           | Downgrade                      |
| `low`           | `low`           | Direct                         |
| `medium`        | `medium`        | Direct                         |
| `high`          | `high`          | Direct                         |
| `xhigh`         | `high`          | Downgrade (no Grok equivalent) |
| `max`           | `high`          | Downgrade (no Grok equivalent) |

Empirically verified: Grok accepts `high`, `medium`, `low`; rejects `none`, `auto`.

**Tool name compatibility**: pi tool names (`read`, `bash`, `edit`, `write`, `grep`, `find`...) may not match Grok's built-in tool names. If `agent.tools`/`agent.excludeTools` contains pi-specific names, Grok may silently ignore them. **Decision**: pass through as-is; document that tool lists are runtime-specific. Grok agents without explicit tool lists use all Grok built-in tools.

**Auth**: Grok CLI reads `XAI_API_KEY` from environment, or uses cached credentials from `grok login`. Pass through parent environment via `buildChildAgentEnv()` (PI*AGENT*\* vars are harmless no-ops for Grok). User must set up Grok auth before using Grok agents.

### Phase 3: Grok stream parser

**New file**: `packages/pi-agents/src/grok-parser.ts`

Empirically verified streaming-json schema (3 event types only):

```
{"type":"thought","data":"..."}     <- reasoning tokens (streamed one by one)
{"type":"text","data":"..."}        <- assistant text (streamed in small chunks)
{"type":"end","stopReason":"...","sessionId":"...","requestId":"..."}
```

**stopReason mapping** (Grok -> pi conventions):

| Grok `stopReason` | Trigger           | exit code | Map to pi   | In FAILURE_STOP_REASONS? |
| ----------------- | ----------------- | --------- | ----------- | ------------------------ |
| `EndTurn`         | Normal completion | 0         | `end`       | No (success)             |
| `Cancelled`       | max-turns reached | 1         | `max_turns` | Yes (failure)            |

Without explicit mapping, `Cancelled` is only caught by the `exitCode !== 0` check in `isFailedResult()` - fragile if Grok ever returns exit 0 with `Cancelled`. The parser must normalize stopReason values.

**Synthetic Message construction**: Since Grok doesn't emit per-message events, the parser accumulates `text` events and constructs 1 synthetic assistant `Message` at the `end` event:

```typescript
{
  role: 'assistant',
  content: [{ type: 'text', text: accumulatedText }],
  model: agent.model,           // from config, not from Grok output
  stopReason: mappedStopReason, // normalized per table above
  usage: undefined,             // Grok doesn't expose usage
}
```

**stderr handling**: Grok prints `Error: max turns reached` to stderr on `Cancelled`. Capture into `SingleResult.stderr` (same as pi path).

**Interface**:

```typescript
export function parseGrokEvent(line: string, result: SingleResult, onUpdate: () => void): void;
```

The parser accumulates `text` event data, calls `onUpdate` on each `text` chunk for progressive display, and finalizes the `SingleResult` on the `end` event (stopReason mapping + synthetic message + turn count = 1).

**Fallback**: If streaming-json format breaks in future Grok versions, fall back to `--output-format json` (single final JSON). Trade-off: no progressive updates, but parsing is trivial (single `{ text, stopReason, ... }` object).

### Phase 4: execution.ts dispatch

**File**: `packages/pi-agents/src/execution.ts`

In `runSingleAgent()`, add a runtime dispatch:

```typescript
if (agent.runtime === 'grok') {
  return runSingleAgentGrok(
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    makeDetails,
    options
  );
}
// existing pi path continues unchanged
```

Or alternatively, extract the existing pi path into `runSingleAgentPi()` and add `runSingleAgentGrok()` as a sibling, with `runSingleAgent()` as a thin dispatcher.

**New function**: `runSingleAgentGrok()` - mirrors `runSingleAgent()` but:

- Calls `buildGrokArgs()` instead of `buildPiArgs()`
- Calls `getGrokInvocation()` instead of `getPiInvocation()` (resolves `grok` binary from PATH, no pi-bundle fallback logic needed)
- Uses `parseGrokEvent()` instead of the inline `processLine`
- No temp file management (system prompt passed as inline `--rules` text)
- Same abort signal handling, maxTurns enforcement (relies on Grok's `--max-turns` + stopReason mapping)
- `getGrokInvocation()` binary resolution: always `{ command: 'grok', args }` (Grok is a standalone binary, not a runtime+script like pi)

### Phase 5: Tool orchestration updates

**File**: `packages/pi-agents/src/tool.ts`

In `runStepWithContext()`, the `agentContext` preparation (session file, etc.) is pi-specific. For Grok agents, skip the session file logic (Grok manages sessions independently). Add a guard:

```typescript
if (agent.runtime !== 'grok') {
  agentContext = prepareAgentContext(agent, ctx);
}
```

**`defaultContext: 'fork'` incompatibility**: `prepareAgentContext()` creates a session file for context forking, which is pi-specific. If a Grok agent has `defaultContext: 'fork'`, it is silently ignored (Grok starts fresh every time). **Decision**: log a warning at discovery/invoke time if a Grok agent requests fork context. Do not error - the agent still works, just without context inheritance.

**Worktree isolation**: works unchanged for Grok agents. The worktree path becomes `effectiveCwd`, passed as spawn `cwd` + `--cwd` flag. `worktreeSetupHook` (pi-side shell command) runs before Grok spawns.

### Phase 6: Security/env adjustments

**File**: `packages/pi-agents/src/security.ts`

Grok doesn't understand `PI_AGENT_DEPTH` environment variables, but we still need nesting depth control. Options:

- **A**: Disallow agent tool for Grok subagents (`--no-subagents`) — simplest, prevents recursive delegation
- **B**: Track depth ourselves and enforce at the pi level before spawning grok

Recommend **Option A** for initial implementation. Grok subagents cannot spawn further subagents through pi's agent tool (though Grok may have its own subagent mechanism — `--no-subagents` disables that too).

**Session/memory defaults**: Grok sessions are stored in `~/.grok/sessions`. For headless subagent execution, always pass `--no-memory` (disables cross-session memory) to prevent state leakage between subagent invocations. This mirrors pi's `--no-session` default. Do not pass `--session-id` (each subagent run is a fresh one-shot).

### Phase 7: Constants

**File**: `packages/pi-agents/src/constants.ts`

Add:

```typescript
export const GROK_RUNTIME = 'grok' as const;
export const DEFAULT_RUNTIME = 'pi' as const;
export const GROK_BINARY = 'grok' as const;
```

### Phase 8: Testing

**New file**: `packages/pi-agents/tests/grok-invocation.test.ts`
**New file**: `packages/pi-agents/tests/grok-parser.test.ts`

### Phase 9: Documentation

- Add `runtime` field to agent Markdown frontmatter documentation in README
- Document Grok prerequisites (`grok login` or `XAI_API_KEY` env var)
- Add example Grok agent definition

## Empirical Findings (grok CLI, tested 2026-07-10)

### `--output-format streaming-json` (NDJSON, one JSON object per line)

```
{"type":"thought","data":"..."}     ← reasoning tokens (streamed one by one)
{"type":"text","data":"..."}        ← assistant text (streamed in small chunks)
{"type":"end","stopReason":"EndTurn","sessionId":"...","requestId":"..."}
```

### `--output-format json` (single final JSON object)

```json
{
  "text": "full assistant response",
  "stopReason": "EndTurn",
  "sessionId": "uuid",
  "requestId": "uuid",
  "thought": "optional condensed reasoning text"
}
```

### Critical Gaps vs pi's JSON mode

| Capability                           | pi `--mode json`                | Grok `json`          | Grok `streaming-json`   |
| ------------------------------------ | ------------------------------- | -------------------- | ----------------------- |
| Per-message events (`message_end`)   | ✅                              | ❌                   | ❌                      |
| Tool call events (`tool_result_end`) | ✅                              | ❌ (transparent)     | ❌ (transparent)        |
| Usage stats (tokens, cost, cache)    | ✅ `message.usage`              | ❌                   | ❌                      |
| Turn count tracking                  | ✅                              | ❌                   | ❌                      |
| Stop reason detail                   | ✅ `stopReason`, `errorMessage` | ✅ `stopReason` only | ✅ `stopReason` only    |
| Structured output                    | ❌                              | ✅ `--json-schema`   | ❌                      |
| Progressive text updates             | ✅ event stream                 | ❌                   | ✅ text chunk streaming |
| Reasoning/thought                    | ❌                              | ✅ `thought` field   | ✅ `thought` stream     |

### stopReason values discovered

| Grok `stopReason` | Trigger           | exit code | stderr                     |
| ----------------- | ----------------- | --------- | -------------------------- |
| `EndTurn`         | Normal completion | 0         | (none)                     |
| `Cancelled`       | max-turns reached | 1         | `Error: max turns reached` |

Other values may exist (error conditions, aborts) - not yet observed. The parser should handle unknown stopReasons defensively (treat as potential failure if exitCode != 0).

### thinking/effort compatibility

pi `--thinking` accepts 7 levels: `off, minimal, low, medium, high, xhigh, max`
Grok `--effort` accepts 3 levels: `high, medium, low` (rejects `none`, `auto`)

See Phase 2 mapping table for downgrade logic.

### System prompt flag semantics

| Flag                              | Takes       | Mode    | Verified                                         |
| --------------------------------- | ----------- | ------- | ------------------------------------------------ |
| `--rules <TEXT>`                  | inline text | append  | works                                            |
| `--system-prompt-override <TEXT>` | inline text | replace | partially works (defaults may leak)              |
| `--append-system-prompt <FILE>`   | file path   | append  | **does NOT work** (path treated as literal text) |

### Additional Grok CLI flags discovered

- `--prompt-file <PATH>` — read prompt from file (alternative to `-p`)
- `--prompt-json <JSON>` — prompt as JSON content blocks
- `--json-schema <SCHEMA>` — JSON Schema for structured output (implies `--output-format json`)
- `--best-of-n <N>` — run N ways in parallel, pick best
- `--check` — append self-verification loop
- `--reasoning-effort <EFFORT>` (alias `--effort`) — reasoning effort
- `--permission-mode <MODE>` — permission: default, acceptEdits, auto, dontAsk, bypassPermissions, plan
- `--agent <NAME>` — load a Grok-native agent definition
- `--agents <JSON>` — inline subagent definitions as JSON

## Open Questions & Risks

### Q1: Grok output schema (RESOLVED ✅)

Empirical test confirms only 3 streaming event types: `thought`, `text`, `end`. The `json` output has `{ text, stopReason, sessionId, requestId, thought }`.

**Decision**: Use `streaming-json` for progressive text updates. Accept degraded fidelity:

- No per-message collection → `SingleResult.messages` gets 1 synthetic assistant message
- No usage stats → `SingleResult.usage` all zeros
- No turn events → `turns` comes from our own counter (1 per `end` event), `maxTurns` enforced by Grok's `--max-turns`

### Q2: Grok skill/hook integration

Pi skills and hooks are pi-specific. Grok has its own skill/hook system. We cannot translate pi skills to Grok skills automatically.

- **Decision**: `resolvedSkillPaths` and hooks are no-ops for Grok agents. If an agent needs skills, use the `pi` runtime.

### Q3: Progress callbacks during execution

`streaming-json` provides progressive `text` events → we can call `onUpdate` with accumulating text.
No intermediate turn count since Grok doesn't expose per-turn boundaries.

### Q4: Auth in CI/headless environments

Grok supports `XAI_API_KEY` env var and `grok login --device-auth`. Pass parent environment through; users must set up Grok auth before using Grok agents.

### Q5: Grok CLI binary not installed

If `grok` is not on PATH, spawn will fail with a clear error. Optionally add pre-flight check in `discoverAgents()` to skip Grok agents when binary is unavailable.

### Q6: Tool call visibility (NEW)

Grok handles tools transparently - tool execution is internal, not in output. This means:

- Parent cannot see which tools Grok used
- `SingleResult.messages` won't include tool result messages
- Acceptable: single-task delegation only cares about final output

### Q7: Tool name compatibility (NEW)

pi tool names (`read`, `bash`, `edit`, `write`, `grep`, `find`) may not match Grok's built-in tool names. If an agent definition restricts tools, the restriction may be silently ignored by Grok.

- **Decision**: pass `--tools`/`--disallowed-tools` through as-is. Document that tool lists are runtime-specific. If tool restriction is critical, use `pi` runtime.
- **Future**: build a pi->Grok tool name translation table once Grok's tool names are catalogued.

### Q8: `--system-prompt-override` replace mode reliability (NEW)

Empirically, `--system-prompt-override` does not fully suppress Grok's default behavior - project-level `.grok/` config and context files may still influence output. Append mode (`--rules`) works reliably.

- **Decision**: default to `--rules` (append). Only use `--system-prompt-override` when `systemPromptMode: 'replace'` is explicitly set, and document the caveat.

## Effort Estimate (updated after empirical test + review)

| Phase                    | Effort  | Risk   | Notes                                                              |
| ------------------------ | ------- | ------ | ------------------------------------------------------------------ |
| 1. AgentConfig extension | Small   | Low    | Add `runtime` field + parser                                       |
| 2. Grok argument builder | Small   | Low    | Native flags, inline text, thinking->effort downgrade mapping      |
| 3. Grok stream parser    | Small   | Low    | 3 event types + stopReason mapping + synthetic Message             |
| 4. execution.ts dispatch | Medium  | Low    | Refactor inline parser, add runSingleAgentGrok()                   |
| 5. Tool orchestration    | Small   | Low    | Skip agentContext for grok + fork context warning                  |
| 6. Security/env          | Small   | Low    | `--no-subagents`, `--no-memory`, pass env through                  |
| 7. Constants             | Trivial | Low    |                                                                    |
| 8. Testing               | Medium  | Medium | Test grok binary availability, stopReason mapping, thinking levels |
| 9. Documentation         | Small   | Low    | Document caveats: tool names, replace mode, fork context           |

**Total**: ~1 day. All high risks eliminated by empirical testing. Remaining medium risk is test coverage of edge cases (unknown stopReasons, thinking downgrade behavior).
