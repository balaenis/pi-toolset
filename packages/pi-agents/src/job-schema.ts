// ABOUTME: TypeBox parameter schema for the `agent_job` tool - list, get, and resume durable runs.
// ABOUTME: Registered with `pi.registerTool` alongside the main `agent` tool.

import { StringEnum, Type } from '@earendil-works/pi-ai';

export type JobAction = 'list' | 'get' | 'resume';
export type StatusFilter =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const JobActionSchema = StringEnum(['list', 'get', 'resume'] as const, {
  description: 'Action to perform: list runs, get details, or resume an interrupted run.',
});

export const StatusFilterSchema = StringEnum(
  ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const,
  {
    description: 'Filter runs by durable status. Omit to list all statuses.',
  }
);

export const JobParams = Type.Object({
  action: JobActionSchema,
  runId: Type.Optional(
    Type.String({
      description: 'Run ID. Required when action is get or resume.',
    })
  ),
  status: Type.Optional(StatusFilterSchema),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: 'Maximum number of runs to list (default 20, max 100).',
    })
  ),
  allowReplay: Type.Optional(
    Type.Boolean({
      description:
        'For resume only: allow replay-capable units to re-run from the beginning. Only set after accepting duplicate-side-effect risk.',
    })
  ),
});
