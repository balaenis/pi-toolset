// ABOUTME: Native pi-schema parameters for the `agent` tool — single, parallel, chain, and scope inputs.
// ABOUTME: Open `SubagentParams` and helper object schemas preserve permissive tool inputs.

import {
  arr,
  bool,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  unknown as unknownSchema,
} from '@earendil-works/pi-schema';

export const IsolationSchema = oneOf(['none', 'worktree'] as const, {
  description:
    'Per-task isolation. "worktree" runs the child in a fresh git worktree under .worktrees/.',
});

export const TitleSchema = str({
  description:
    'Short label (aim for ~30 chars) shown in the collapsed summary instead of the task preview (e.g. "fix lint"). Longer values are accepted and clamped when rendered. Omit to use the task preview.',
});

export const RuntimeSchema = oneOf(['pi', 'grok-acp'] as const, {
  description:
    "Override the agent config `runtime` for every agent in this call. `pi` (default) spawns the pi CLI; `grok-acp` spawns Grok ACP over stdio. Defaults to each agent's configured runtime.",
});

export const TaskItem = obj(
  {
    agent: str({ description: 'Name of the agent to invoke' }),
    task: str({ description: 'Task to delegate to the agent' }),
    title: opt(TitleSchema),
    cwd: opt(str({ description: 'Working directory for the agent process' })),
    isolation: opt(IsolationSchema),
  },
  { open: true }
);

export const SequentialChainItem = obj(
  {
    agent: str({ description: 'Name of the agent to invoke' }),
    task: str({
      description:
        'Task with optional {previous} or {outputs.<name>} placeholders that reference earlier chain outputs',
    }),
    title: opt(TitleSchema),
    cwd: opt(str({ description: 'Working directory for the agent process' })),
    isolation: opt(IsolationSchema),
    name: opt(
      str({
        description:
          'Name used to reference this step’s output as `{outputs.<name>}` from later chain steps',
      })
    ),
    outputSchema: opt(
      unknownSchema({
        description:
          'JSON Schema subset for the required structured output of this step. When set, the result is parsed and validated against it. Supports type/properties/required/items/enum/additionalProperties/minItems/maxItems.',
      })
    ),
  },
  { open: true }
);

export const FanoutChainItem = obj(
  {
    expand: obj(
      {
        from: obj(
          {
            output: str({
              description:
                'Name of a previous chain output that produced structured output (a step with `outputSchema` set and validated). Fanout fails if the referenced output has no structured data.',
            }),
            path: str({
              description:
                'JSON Pointer path (RFC 6901, e.g. "/items" or "/results/0/data") to an array inside the structured output.',
            }),
          },
          { open: true }
        ),
        maxItems: opt(num({ description: 'Maximum items to expand' })),
      },
      { open: true }
    ),
    parallel: obj(
      {
        agent: str({ description: 'Name of the agent to invoke for every item' }),
        task: str({ description: 'Task template with optional {item} placeholder' }),
        title: opt(TitleSchema),
        cwd: opt(str({ description: 'Working directory for the agent process' })),
        isolation: opt(IsolationSchema),
        outputSchema: opt(
          unknownSchema({ description: 'Optional structured output schema for each fanout item' })
        ),
      },
      { open: true }
    ),
    collect: obj(
      {
        name: str({
          description:
            "Name used to reference collected fanout results as `{outputs.<name>}` from later chain steps. The value is a JSON array of all items' outputs (or each item's structured output when `outputSchema` is set).",
        }),
      },
      { open: true }
    ),
    concurrency: opt(num({ description: 'Maximum concurrent fanout workers' })),
  },
  { open: true }
);

export const ChainItem = union([SequentialChainItem, FanoutChainItem], {
  description: 'Sequential step or dynamic fanout step',
});

export const AgentScopeSchema = oneOf(['user', 'project', 'both'] as const, {
  description:
    'Which agent directories to load. "both" (default) merges user and project agents with project overriding user; "user" or "project" limits to that scope.',
  default: 'both',
});

export const SubagentParams = obj(
  {
    agent: opt(str({ description: 'Name of the agent to invoke (for single mode)' })),
    task: opt(
      str({
        description:
          'Task to delegate (single mode), or an additional continuation instruction when resuming via runId.',
      })
    ),
    title: opt(TitleSchema),
    tasks: opt(arr(TaskItem, { description: 'Array of {agent, task} for parallel execution' })),
    chain: opt(
      arr(ChainItem, {
        description: 'Array of sequential chain steps and optional dynamic fanout steps',
      })
    ),
    agentScope: opt(AgentScopeSchema),
    cwd: opt(str({ description: 'Working directory for the agent process (single mode)' })),
    isolation: opt(IsolationSchema),
    runInBackground: opt(
      bool({
        description:
          'Run this agent workflow in the background (default). Set to false to wait synchronously for the result in the current turn. ',
      })
    ),
    model: opt(
      str({
        description:
          "Override the agent config `model` for every agent in this call. Defaults to each agent's configured model; set only to force a specific model.",
      })
    ),
    thinking: opt(
      str({
        description:
          "Override the agent config `thinking` for every agent in this call. Defaults to each agent's configured thinking; set only to force a specific thinking level.",
      })
    ),
    runtime: opt(RuntimeSchema),
    runId: opt(
      str({
        description:
          'Resume an existing durable run by ID. Restores the stored workflow, sessions, and settings. Mutually exclusive with fresh launch fields (agent, tasks, chain, agentScope, cwd, isolation, runInBackground, model, thinking, runtime, title). Optional task appends a continuation instruction (required to resume a fully completed run).',
      })
    ),
  },
  { open: true }
);
