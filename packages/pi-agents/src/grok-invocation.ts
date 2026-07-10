// ABOUTME: Grok CLI invocation helpers - argument construction and binary resolution.
// ABOUTME: Maps AgentConfig fields onto Grok native flags with thinking->effort downgrade mapping.

import type { AgentConfig } from './agents.ts';
import { GROK_BINARY } from './constants.ts';

export interface BuildGrokArgsOptions {
  /** Accepted for call-site symmetry with pi; always ignored — Grok always gets --no-subagents. */
  disableAgentTool?: boolean;
  /** Accepted for call-site symmetry with pi; pi skills are not translatable to Grok. */
  resolvedSkillPaths?: string[];
}

function mapThinkingToEffort(thinking?: string): string | undefined {
  switch (thinking) {
    case 'off':
      return undefined;
    case 'minimal':
      return 'low';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'high';
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

export function buildGrokArgs(
  agent: AgentConfig,
  task: string,
  _options: BuildGrokArgsOptions = {}
): string[] {
  // Always disable Grok-native subagents: Grok ignores PI_AGENT_DEPTH / nesting env.
  const args: string[] = [
    '--no-auto-update',
    '--always-approve',
    '--output-format',
    'streaming-json',
    '--no-memory',
    '--no-subagents',
  ];

  if (agent.model) args.push('--model', agent.model);

  const effort = mapThinkingToEffort(agent.thinking);
  if (effort) args.push('--effort', effort);

  if (agent.maxTurns) args.push('--max-turns', String(agent.maxTurns));

  if (agent.systemPrompt.trim()) {
    if (agent.systemPromptMode === 'replace') {
      args.push('--system-prompt-override', agent.systemPrompt);
    } else {
      args.push('--rules', agent.systemPrompt);
    }
  }

  if (agent.tools && agent.tools.length > 0) {
    args.push('--tools', agent.tools.join(','));
  }
  if (agent.excludeTools && agent.excludeTools.length > 0) {
    args.push('--disallowed-tools', agent.excludeTools.join(','));
  }

  args.push('-p', `Task: ${task}`);
  return args;
}

export function getGrokInvocation(args: string[]): { command: string; args: string[] } {
  return { command: GROK_BINARY, args };
}
