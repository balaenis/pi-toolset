// ABOUTME: Chain execution engine — orchestrates sequential subagent steps with templated handoff.
// ABOUTME: Exposes runChainWorkflow with injectable runStep so the loop is unit-testable without spawning pi.

import type { Static } from '@earendil-works/pi-ai';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import type { AgentConfig, AgentSource } from './agents.ts';
import type { OnUpdateCallback } from './execution.ts';
import { getFinalOutput, getResultOutput, isFailedResult } from './output.ts';
import type { ChainItem } from './schema.ts';
import {
  buildStructuredOutputInstruction,
  extractJsonFromFinalOutput,
  validateStructuredOutput,
  type JsonSchemaSubset,
} from './structured-output.ts';
import { renderTaskTemplate } from './template.ts';
import type { ChainOutputEntry, IsolationMode, SingleResult, SubagentDetails } from './types.ts';

export type ChainItemInput = Static<typeof ChainItem>;

export type DetailsFactory = (
  results: SingleResult[],
  outputs?: Record<string, ChainOutputEntry>
) => SubagentDetails;

export interface ChainStepRequest {
  agent: string;
  task: string;
  cwd: string | undefined;
  isolation: IsolationMode | undefined;
  taskIndex: number;
  step: number;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdateCallback | undefined;
  skipCompletionCheck?: boolean;
}

export type ChainRunStep = (req: ChainStepRequest) => Promise<SingleResult>;

export interface RunChainWorkflowOptions {
  chain: ChainItemInput[];
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined;
  makeDetails: DetailsFactory;
  runStep: ChainRunStep;
}

export type ChainResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

export function synthesizeFailure(
  agentName: string,
  agent: AgentConfig | undefined,
  task: string,
  step: number | undefined,
  stopReason: string,
  message: string
): SingleResult {
  return {
    agent: agentName,
    agentSource: (agent?.source ?? 'unknown') as AgentSource | 'unknown',
    task,
    exitCode: 1,
    messages: [],
    stderr: message,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    stopReason,
    errorMessage: message,
    step,
  };
}

export async function runChainWorkflow(options: RunChainWorkflowOptions): Promise<ChainResult> {
  const { chain, signal, onUpdate, makeDetails, runStep } = options;
  const results: SingleResult[] = [];
  let previousOutput = '';
  const outputs = new Map<string, ChainOutputEntry>();

  const outputsRecord = (): Record<string, ChainOutputEntry> => Object.fromEntries(outputs);

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const rendered = renderTaskTemplate(step.task, { previous: previousOutput, outputs });
    if (!rendered.ok) {
      const failure = synthesizeFailure(
        step.agent,
        undefined,
        step.task,
        i + 1,
        'template_error',
        `Unknown chain output: ${rendered.unknown}`
      );
      results.push(failure);
      return {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${i + 1} (${step.agent}): Unknown chain output: ${rendered.unknown}`,
          },
        ],
        details: makeDetails(results, outputsRecord()),
        isError: true,
      };
    }
    const rawSchema = (step as { outputSchema?: unknown }).outputSchema;
    let outputSchema: JsonSchemaSubset | undefined;
    if (rawSchema === undefined || rawSchema === null) {
      outputSchema = undefined;
    } else if (typeof rawSchema === 'object' && !Array.isArray(rawSchema)) {
      outputSchema = rawSchema as JsonSchemaSubset;
    } else {
      const failure = synthesizeFailure(
        step.agent,
        undefined,
        step.task,
        i + 1,
        'structured_output_error',
        `Invalid outputSchema: expected object, got ${Array.isArray(rawSchema) ? 'array' : typeof rawSchema}`
      );
      results.push(failure);
      return {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${i + 1} (${step.agent}): ${failure.errorMessage}`,
          },
        ],
        details: makeDetails(results, outputsRecord()),
        isError: true,
      };
    }
    let taskWithContext = rendered.text;
    if (outputSchema) {
      taskWithContext = `${rendered.text}\n\n${buildStructuredOutputInstruction(outputSchema)}`;
    }

    const chainUpdate: OnUpdateCallback | undefined = onUpdate
      ? (partial) => {
          const currentResult = partial.details?.results[0];
          if (currentResult) {
            const allResults = [...results, currentResult];
            onUpdate({
              content: partial.content,
              details: makeDetails(allResults, outputsRecord()),
            });
          }
        }
      : undefined;

    const result = await runStep({
      agent: step.agent,
      task: taskWithContext,
      cwd: step.cwd,
      isolation: step.isolation,
      taskIndex: i,
      step: i + 1,
      signal,
      onUpdate: chainUpdate,
      skipCompletionCheck: outputSchema !== undefined,
    });

    if (result.messages.length > 0) {
      result.finalOutput = getFinalOutput(result.messages);
    }

    if (!isFailedResult(result)) {
      if (outputSchema) {
        const finalOutput = result.finalOutput ?? '';
        const extracted = extractJsonFromFinalOutput(finalOutput);
        if (!extracted.ok) {
          markStructuredFailure(result, extracted.error, i + 1);
        } else {
          const errors = validateStructuredOutput(extracted.value, outputSchema);
          if (errors.length > 0) {
            markStructuredFailure(result, errors.join('; '), i + 1);
          } else {
            result.structuredOutput = extracted.value;
          }
        }
      }
    }

    results.push(result);

    if (isFailedResult(result)) {
      const errorMsg = getResultOutput(result);
      return {
        content: [
          { type: 'text', text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` },
        ],
        details: makeDetails(results, outputsRecord()),
        isError: true,
      };
    }
    previousOutput = result.finalOutput ?? getFinalOutput(result.messages);
    if (step.name) {
      outputs.set(step.name, {
        text: previousOutput,
        structured: result.structuredOutput,
        agent: step.agent,
        step: i + 1,
      });
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: getFinalOutput(results[results.length - 1].messages) || '(no output)',
      },
    ],
    details: makeDetails(results, outputsRecord()),
  };
}

function markStructuredFailure(result: SingleResult, message: string, step: number): void {
  result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
  result.stopReason = 'structured_output_error';
  result.structuredOutputError = message;
  result.errorMessage = `Structured output error: ${message}`;
  if (typeof result.step !== 'number') result.step = step;
}
