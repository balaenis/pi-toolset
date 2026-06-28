// ABOUTME: Shared runtime types for subagent results, usage stats, and display items.
// ABOUTME: Re-exported from agents.ts scope/source types and consumed across execution and rendering.

import type { Message } from '@earendil-works/pi-ai';
import type { AgentScope, AgentSource } from './agents.ts';

export type SystemPromptMode = 'append' | 'replace';
export type DefaultContext = 'fresh' | 'fork';
export type IsolationMode = 'none' | 'worktree';

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | 'unknown';
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  thinking?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  worktreePath?: string;
  worktreeDirty?: boolean;
  worktreeDiffStat?: string;
  worktreeChangedFiles?: string[];
  worktreeSetupError?: string;
  finalOutput?: string;
  structuredOutput?: unknown;
  structuredOutputError?: string;
}

export interface ChainOutputEntry {
  text: string;
  structured?: unknown;
  agent: string;
  step: number;
}

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundLaunchDetails {
  jobId: string;
  mode: 'single' | 'parallel' | 'chain';
  status: BackgroundJobStatus;
  agentScope: AgentScope;
  description: string;
  startedAt: number;
  taskPreview: string;
}

export interface BackgroundNotificationDetails {
  jobId: string;
  mode: 'single' | 'parallel' | 'chain';
  status: BackgroundJobStatus;
  description: string;
  startedAt: number;
  finishedAt: number;
  durationMs?: number;
  result?: string;
  error?: string;
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain' | 'background';
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  builtinAgentsDir: string;
  results: SingleResult[];
  outputs?: Record<string, ChainOutputEntry>;
  background?: BackgroundLaunchDetails[];
}

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };
