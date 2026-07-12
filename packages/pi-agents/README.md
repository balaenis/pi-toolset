# @balaenis/pi-agents

Delegate tasks to specialized subagents from [Pi](https://github.com/earendil-works/pi). Each invocation spawns an isolated `pi` subprocess with its own context window, then streams structured updates back into the parent session.

## Features

- **Isolated context** - every subagent runs in a fresh `pi` process
- **Background agents** - long-running invocations return immediately and notify the parent via a custom message when they finish (`runInBackground: true`)
- **Streaming output** - tool calls and progress arrive live
- **Three execution modes** - single, parallel (max 8, 4 concurrent), and chained
- **Structured chain outputs** - per-step `outputSchema` extracts and validates JSON before passing it forward as `{outputs.<name>}`
- **Dynamic fanout** - chain steps expand a prior step's array output into parallel subtasks with a collected result
- **Package agents** - install agents from npm packages that declare `pi.agents`
- **Slash-command invocation** - `/agent:<name> <task>` runs a discovered agent directly; `/agent list` enumerates them
- **Worktree isolation + setup hook** - run agents in a throw-away git worktree with an optional shell `worktreeSetupHook` and per-run diff metadata
- **Completion check** - require final-message headings via frontmatter
- **Compact live rendering** - collapsed view is a status summary (glyph, agent, truncated task or a short `title`, usage, at most one latest activity); Ctrl+O expands full task/transcript/final output
- **Short collapse titles** - optional `title` (max 30 characters) on single, parallel tasks, chain steps, and fanout steps replaces the task preview in the collapsed summary; generate it before the call
- **Parallel & Chain progress** - ordered per-task summaries; Chain fanout is one logical step with real item counts and collect metadata
- **Usage tracking** - turns, tokens, and context per execution unit; aggregates sum tokens/turns and use `ctx:max` (no aggregate model/thinking); partial stats stream live for `grok-acp`
- **Abort support** - Ctrl+C propagates and kills active subprocesses

## Local development

The package is not published to a registry yet. Build it and load it with `-e`:

```sh
mise run build --package packages/pi-agents
pi -e ./packages/pi-agents/dist/index.js
```

## Documentation

- [Tutorial: Get started with subagents](./docs/tutorials.md) - load the extension and run your first agents
- [How-to guides](./docs/how-to.md) - parallel runs, chains, structured output, fanout, worktree isolation, slash commands, background agents, Grok runtimes
- [Reference](./docs/reference.md) - frontmatter fields, config overrides, tool modes, bundled agents, `stopReason` values, environment variables
- [Explanation](./docs/explanation.md) - security model, nesting control, fork context, package-agent discovery, Grok runtimes

## Bundled agents

| Agent      | Purpose              | Tools                         | Nested agents                    |
| ---------- | -------------------- | ----------------------------- | -------------------------------- |
| `explore`  | Fast codebase recon  | `read, grep, find, ls, bash`  | disabled (`maxSubagentDepth: 0`) |
| `planner`  | Implementation plans | `read, grep, find, ls, write` | disabled (`maxSubagentDepth: 0`) |
| `reviewer` | Code review          | `read, grep, find, ls, bash`  | disabled (`maxSubagentDepth: 0`) |
| `worker`   | General-purpose      | (all default)                 | follows `PI_AGENT_MAX_DEPTH`     |

The package also ships prompt templates: the `/implement`, `/explore-and-plan`, and `/implement-and-review` workflow prompts, plus `/work-with-grok` for delegating a task to the Grok ACP runtime. See [How-to guides](./docs/how-to.md#use-the-bundled-workflow-prompts).

## Development

```sh
mise run typecheck --package packages/pi-agents
mise run test --package packages/pi-agents
mise run build --package packages/pi-agents
hk check
```

## License

See [LICENSE](../../LICENSE).
