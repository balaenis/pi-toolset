// ABOUTME: Chain execution engine — orchestrates sequential subagent steps with templated handoff.
// ABOUTME: Exposes runChainWorkflow with injectable runStep so the loop is unit-testable without spawning pi.

import type { Static } from '@earendil-works/pi-ai';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import type { AgentConfig, AgentSource } from './agents.ts';
import { MAX_CONCURRENCY, MAX_FANOUT_ITEMS } from './constants.ts';
import { mapWithConcurrencyLimit, type OnUpdateCallback } from './execution.ts';
import { readJsonPointer } from './json-pointer.ts';
import { getFinalOutput, getResultOutput, isFailedResult } from './output.ts';
import type { ChainItem } from './schema.ts';
import {
  buildStructuredOutputInstruction,
  extractJsonFromFinalOutput,
  validateStructuredOutput,
  type JsonSchemaSubset,
  type JsonValue,
} from './structured-output.ts';
import { renderTaskTemplate } from './template.ts';
import type { ChainOutputEntry, IsolationMode, SingleResult, SubagentDetails } from './types.ts';

export type ChainItemInput = Static<typeof ChainItem>;

type SequentialStep = Extract<ChainItemInput, { agent: string }>;
type FanoutStep = Extract<ChainItemInput, { expand: unknown }>;

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
    const stepNumber = i + 1;

    if (isFanoutChainStep(step)) {
      const fanout = await runFanoutStep({
        step,
        stepNumber,
        results,
        outputs,
        previousOutput,
        signal,
        onUpdate,
        makeDetails,
        outputsRecord,
        runStep,
      });
      if (fanout.done) return fanout.result;
      previousOutput = fanout.previousOutput;
      continue;
    }

    if (isAmbiguousChainStep(step)) {
      const failure = synthesizeFailure(
        'unknown',
        undefined,
        '',
        stepNumber,
        'fanout_error',
        'Chain step must be sequential (agent/task) or fanout (expand/parallel/collect), not both.'
      );
      results.push(failure);
      return {
        content: [
          { type: 'text', text: `Chain stopped at step ${stepNumber}: ${failure.errorMessage}` },
        ],
        details: makeDetails(results, outputsRecord()),
        isError: true,
      };
    }

    const sequential = await runSequentialStep({
      step: step as SequentialStep,
      stepNumber,
      taskIndex: i,
      results,
      outputs,
      previousOutput,
      signal,
      onUpdate,
      makeDetails,
      outputsRecord,
      runStep,
    });
    if (sequential.done) return sequential.result;
    previousOutput = sequential.previousOutput;
  }

  return {
    content: [
      {
        type: 'text',
        text:
          previousOutput || getFinalOutput(results[results.length - 1].messages) || '(no output)',
      },
    ],
    details: makeDetails(results, outputsRecord()),
  };
}

export function isFanoutChainStep(step: ChainItemInput): step is FanoutStep {
  return typeof step === 'object' && step !== null && !('agent' in step) && 'expand' in step;
}

function isAmbiguousChainStep(step: ChainItemInput): boolean {
  return typeof step === 'object' && step !== null && 'agent' in step && 'expand' in step;
}

function parseOutputSchema(
  rawSchema: unknown,
  agent: string,
  task: string,
  stepNumber: number
): { ok: true; schema: JsonSchemaSubset | undefined } | { ok: false; failure: SingleResult } {
  if (rawSchema === undefined || rawSchema === null) return { ok: true, schema: undefined };
  if (typeof rawSchema === 'object' && !Array.isArray(rawSchema)) {
    return { ok: true, schema: rawSchema as JsonSchemaSubset };
  }
  return {
    ok: false,
    failure: synthesizeFailure(
      agent,
      undefined,
      task,
      stepNumber,
      'structured_output_error',
      `Invalid outputSchema: expected object, got ${Array.isArray(rawSchema) ? 'array' : typeof rawSchema}`
    ),
  };
}

function applyStructuredOutputValidation(
  result: SingleResult,
  schema: JsonSchemaSubset | undefined,
  stepNumber: number
): void {
  if (result.messages.length > 0) {
    result.finalOutput = getFinalOutput(result.messages);
  }
  if (isFailedResult(result) || !schema) return;

  const extracted = extractJsonFromFinalOutput(result.finalOutput ?? '');
  if (!extracted.ok) {
    markStructuredFailure(result, extracted.error, stepNumber);
    return;
  }
  const errors = validateStructuredOutput(extracted.value, schema);
  if (errors.length > 0) {
    markStructuredFailure(result, errors.join('; '), stepNumber);
    return;
  }
  result.structuredOutput = extracted.value;
}

interface StepShared {
  results: SingleResult[];
  outputs: Map<string, ChainOutputEntry>;
  previousOutput: string;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined;
  makeDetails: DetailsFactory;
  outputsRecord: () => Record<string, ChainOutputEntry>;
  runStep: ChainRunStep;
}

async function runSequentialStep(
  opts: StepShared & { step: SequentialStep; stepNumber: number; taskIndex: number }
): Promise<{ done: false; previousOutput: string } | { done: true; result: ChainResult }> {
  const { step, stepNumber, results, outputs, previousOutput, signal, onUpdate, makeDetails } =
    opts;
  const rendered = renderTaskTemplate(step.task, { previous: previousOutput, outputs });
  if (!rendered.ok) {
    const failure = synthesizeFailure(
      step.agent,
      undefined,
      step.task,
      stepNumber,
      'template_error',
      `Unknown chain output: ${rendered.unknown}`
    );
    results.push(failure);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${stepNumber} (${step.agent}): Unknown chain output: ${rendered.unknown}`,
          },
        ],
        details: makeDetails(results, opts.outputsRecord()),
        isError: true,
      },
    };
  }

  const parsedSchema = parseOutputSchema(step.outputSchema, step.agent, step.task, stepNumber);
  if (!parsedSchema.ok) {
    results.push(parsedSchema.failure);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${stepNumber} (${step.agent}): ${parsedSchema.failure.errorMessage}`,
          },
        ],
        details: makeDetails(results, opts.outputsRecord()),
        isError: true,
      },
    };
  }

  const outputSchema = parsedSchema.schema;
  const taskWithContext = outputSchema
    ? `${rendered.text}\n\n${buildStructuredOutputInstruction(outputSchema)}`
    : rendered.text;

  const chainUpdate = makeChainUpdate(results, onUpdate, makeDetails, opts.outputsRecord);
  const result = await opts.runStep({
    agent: step.agent,
    task: taskWithContext,
    cwd: step.cwd,
    isolation: step.isolation,
    taskIndex: opts.taskIndex,
    step: stepNumber,
    signal,
    onUpdate: chainUpdate,
    skipCompletionCheck: outputSchema !== undefined,
  });

  applyStructuredOutputValidation(result, outputSchema, stepNumber);
  results.push(result);

  if (isFailedResult(result)) {
    const errorMsg = getResultOutput(result);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${stepNumber} (${step.agent}): ${errorMsg}`,
          },
        ],
        details: makeDetails(results, opts.outputsRecord()),
        isError: true,
      },
    };
  }

  const nextPreviousOutput = result.finalOutput ?? getFinalOutput(result.messages);
  if (step.name) {
    outputs.set(step.name, {
      text: nextPreviousOutput,
      structured: result.structuredOutput,
      agent: step.agent,
      step: stepNumber,
    });
  }
  return { done: false, previousOutput: nextPreviousOutput };
}

async function runFanoutStep(
  opts: StepShared & { step: FanoutStep; stepNumber: number }
): Promise<{ done: false; previousOutput: string } | { done: true; result: ChainResult }> {
  const { step, stepNumber, results, outputs, previousOutput, signal, onUpdate, makeDetails } =
    opts;
  const outputName = step.expand.from.output;
  const outputEntry = outputs.get(outputName);
  if (!outputEntry || outputEntry.structured === undefined) {
    return fanoutFailure(
      opts,
      `Fanout source output "${outputName}" is missing structured output.`
    );
  }

  const pointer = readJsonPointer(outputEntry.structured as JsonValue, step.expand.from.path);
  if (!pointer.ok) return fanoutFailure(opts, pointer.error);
  if (!Array.isArray(pointer.value)) {
    return fanoutFailure(
      opts,
      `Fanout source ${outputName}${step.expand.from.path} is not an array.`
    );
  }

  const parsedSchema = parseOutputSchema(
    step.parallel.outputSchema,
    step.parallel.agent,
    step.parallel.task,
    stepNumber
  );
  if (!parsedSchema.ok) {
    results.push(parsedSchema.failure);
    return {
      done: true,
      result: {
        content: [{ type: 'text', text: `Fanout failed: ${parsedSchema.failure.errorMessage}` }],
        details: makeDetails(results, opts.outputsRecord()),
        isError: true,
      },
    };
  }
  const outputSchema = parsedSchema.schema;

  const rawMaxItems = step.expand.maxItems;
  if (rawMaxItems !== undefined) {
    if (typeof rawMaxItems !== 'number' || !Number.isFinite(rawMaxItems) || rawMaxItems < 1) {
      return fanoutFailure(
        opts,
        `Invalid expand.maxItems: expected positive integer, got ${String(rawMaxItems)}`
      );
    }
  }
  const requestedMax = typeof rawMaxItems === 'number' ? Math.floor(rawMaxItems) : MAX_FANOUT_ITEMS;
  const maxItems = Math.min(requestedMax, MAX_FANOUT_ITEMS);
  const items = pointer.value.slice(0, maxItems);
  const skipped = pointer.value.length - items.length;
  const renderedTasks: string[] = [];

  for (const item of items) {
    const rendered = renderTaskTemplate(step.parallel.task, {
      previous: previousOutput,
      outputs,
      item,
    });
    if (!rendered.ok) {
      return fanoutFailure(opts, `Unknown fanout template value: ${rendered.unknown}`);
    }
    renderedTasks.push(
      outputSchema
        ? `${rendered.text}\n\n${buildStructuredOutputInstruction(outputSchema)}`
        : rendered.text
    );
  }

  const concurrency = Math.max(
    1,
    Math.min(
      typeof step.concurrency === 'number' ? Math.floor(step.concurrency) : MAX_CONCURRENCY,
      MAX_CONCURRENCY
    )
  );
  const fanoutResults = await mapWithConcurrencyLimit(
    renderedTasks,
    concurrency,
    async (task, index) => {
      const result = await opts.runStep({
        agent: step.parallel.agent,
        task,
        cwd: step.parallel.cwd,
        isolation: step.parallel.isolation,
        taskIndex: stepNumber * (MAX_FANOUT_ITEMS + 1) + index,
        step: stepNumber,
        signal,
        onUpdate: undefined,
        skipCompletionCheck: outputSchema !== undefined,
      });
      applyStructuredOutputValidation(result, outputSchema, stepNumber);
      if (onUpdate) {
        onUpdate({
          content: [
            { type: 'text', text: `Fanout: ${index + 1}/${renderedTasks.length} completed...` },
          ],
          details: makeDetails([...results, result], opts.outputsRecord()),
        });
      }
      return result;
    }
  );

  results.push(...fanoutResults);
  const successCount = fanoutResults.filter((r) => !isFailedResult(r)).length;
  if (successCount !== fanoutResults.length) {
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Fanout failed: ${successCount}/${fanoutResults.length} succeeded`,
          },
        ],
        details: makeDetails(results, opts.outputsRecord()),
        isError: true,
      },
    };
  }

  const collected = fanoutResults.map(
    (result) =>
      (result.structuredOutput ??
        result.finalOutput ??
        getFinalOutput(result.messages)) as JsonValue
  );
  const text = `${JSON.stringify(collected, null, 2)}${
    skipped > 0
      ? `\n\n[Fanout skipped ${skipped} item${skipped === 1 ? '' : 's'} due to maxItems=${maxItems}]`
      : ''
  }`;
  outputs.set(step.collect.name, {
    text,
    structured: collected,
    agent: step.parallel.agent,
    step: stepNumber,
  });
  return { done: false, previousOutput: text };
}

function fanoutFailure(
  opts: StepShared & { step: FanoutStep; stepNumber: number },
  message: string
): { done: true; result: ChainResult } {
  const failure = synthesizeFailure(
    opts.step.parallel.agent,
    undefined,
    opts.step.parallel.task,
    opts.stepNumber,
    'fanout_error',
    message
  );
  opts.results.push(failure);
  return {
    done: true,
    result: {
      content: [{ type: 'text', text: `Fanout failed: ${message}` }],
      details: opts.makeDetails(opts.results, opts.outputsRecord()),
      isError: true,
    },
  };
}

function makeChainUpdate(
  results: SingleResult[],
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory,
  outputsRecord: () => Record<string, ChainOutputEntry>
): OnUpdateCallback | undefined {
  return onUpdate
    ? (partial) => {
        const currentResult = partial.details?.results[0];
        if (currentResult) {
          onUpdate({
            content: partial.content,
            details: makeDetails([...results, currentResult], outputsRecord()),
          });
        }
      }
    : undefined;
}

function markStructuredFailure(result: SingleResult, message: string, step: number): void {
  result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
  result.stopReason = 'structured_output_error';
  result.structuredOutputError = message;
  result.errorMessage = `Structured output error: ${message}`;
  if (typeof result.step !== 'number') result.step = step;
}
