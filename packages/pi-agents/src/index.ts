// ABOUTME: Subagent tool — delegates tasks to isolated `pi` subprocesses for single, parallel, or chained runs.
// ABOUTME: Registers the `agent` tool, streams structured updates, and injects available agents into the system prompt.

import { type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type AgentConfig, type AgentScope, discoverAgents } from './agents.ts';
import { MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from './constants.ts';
import { mapWithConcurrencyLimit, type OnUpdateCallback, runSingleAgent } from './execution.ts';
import {
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  truncateParallelOutput,
} from './output.ts';
import { renderCall, renderResult } from './render.ts';
import { SubagentParams } from './schema.ts';
import type { SingleResult, SubagentDetails } from './types.ts';

export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event, ctx) => {
    const discovery = discoverAgents(ctx.cwd, 'both');
    const agents = discovery.agents;
    if (agents.length === 0) return;
    const lines = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
    const block = `Available agent types for the \`agent\` tool:\n${lines}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.registerTool({
    name: 'agent',
    label: 'Agent',
    description: `Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.
When using the Agent tool, specify a \`agent\` parameter to select which agent type to use. If omitted, the general-purpose agent is used.
## When to use
Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.
- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.`,
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? 'user';
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: 'single' | 'parallel' | 'chain') =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          builtinAgentsDir: discovery.builtinAgentsDir,
          results,
        });

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
        return {
          content: [
            {
              type: 'text',
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails('single')([]),
        };
      }

      if (
        (agentScope === 'project' || agentScope === 'both') &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === 'project');

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(', ');
          const dir = discovery.projectAgentsDir ?? '(unknown)';
          const ok = await ctx.ui.confirm(
            'Run project-local agents?',
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`
          );
          if (!ok)
            return {
              content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }],
              details: makeDetails(hasChain ? 'chain' : hasTasks ? 'parallel' : 'single')([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = '';

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          // Create update callback that includes all previous results
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                // Combine completed results with current streaming result
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  const allResults = [...results, currentResult];
                  onUpdate({
                    content: partial.content,
                    details: makeDetails('chain')(allResults),
                  });
                }
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails('chain')
          );
          results.push(result);

          const isError = isFailedResult(result);
          if (isError) {
            const errorMsg = getResultOutput(result);
            return {
              content: [
                {
                  type: 'text',
                  text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`,
                },
              ],
              details: makeDetails('chain')(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [
            {
              type: 'text',
              text: getFinalOutput(results[results.length - 1].messages) || '(no output)',
            },
          ],
          details: makeDetails('chain')(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: 'text',
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails('parallel')([]),
          };

        // Track all results for streaming updates
        const allResults: SingleResult[] = new Array(params.tasks.length);

        // Initialize placeholder results
        for (let i = 0; i < params.tasks.length; i++) {
          allResults[i] = {
            agent: params.tasks[i].agent,
            agentSource: 'unknown',
            task: params.tasks[i].task,
            exitCode: -1, // -1 = still running
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          };
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const running = allResults.filter((r) => r.exitCode === -1).length;
            const done = allResults.filter((r) => r.exitCode !== -1).length;
            onUpdate({
              content: [
                {
                  type: 'text',
                  text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                },
              ],
              details: makeDetails('parallel')([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (t, index) => {
            const result = await runSingleAgent(
              ctx.cwd,
              agents,
              t.agent,
              t.task,
              t.cwd,
              undefined,
              signal,
              // Per-task update callback
              (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails('parallel')
            );
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          }
        );

        const successCount = results.filter((r) => !isFailedResult(r)).length;
        const summaries = results.map((r) => {
          const output = truncateParallelOutput(getResultOutput(r));
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}`
            : 'completed';
          return `### [${r.agent}] ${status}\n\n${output}`;
        });
        return {
          content: [
            {
              type: 'text',
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`,
            },
          ],
          details: makeDetails('parallel')(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails('single')
        );
        const isError = isFailedResult(result);
        if (isError) {
          const errorMsg = getResultOutput(result);
          return {
            content: [
              { type: 'text', text: `Agent ${result.stopReason || 'failed'}: ${errorMsg}` },
            ],
            details: makeDetails('single')([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
          details: makeDetails('single')([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
      return {
        content: [{ type: 'text', text: `Invalid parameters. Available agents: ${available}` }],
        details: makeDetails('single')([]),
      };
    },

    renderCall,
    renderResult,
  });
}
