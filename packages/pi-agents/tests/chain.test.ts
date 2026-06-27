// ABOUTME: Tests for runChainWorkflow — sequential handoff, named outputs, template failure, and stop-on-failure.
// ABOUTME: Uses an injected runStep stub so the engine is exercised without spawning real pi processes.

import { describe, expect, it } from 'bun:test';
import { runChainWorkflow, type ChainItemInput, type ChainStepRequest } from '../src/chain.ts';
import type { ChainOutputEntry, SingleResult, SubagentDetails } from '../src/types.ts';

const makeDetails = (
  results: SingleResult[],
  outputs?: Record<string, ChainOutputEntry>
): SubagentDetails => ({
  mode: 'chain',
  agentScope: 'user',
  projectAgentsDir: null,
  builtinAgentsDir: '/tmp',
  results,
  ...(outputs && Object.keys(outputs).length > 0 ? { outputs } : {}),
});

function makeAssistantResult(agent: string, text: string, step: number): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
    exitCode: 0,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
      } as unknown as SingleResult['messages'][number],
    ],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 1,
    },
    step,
  };
}

function makeFailureResult(agent: string, step: number, message: string): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
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
    stopReason: 'error',
    errorMessage: message,
    step,
  };
}

describe('runChainWorkflow', () => {
  it('passes the previous final output to the next step', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'use {previous}' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        return makeAssistantResult(req.agent, `${req.agent} done`, req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0].task).toBe('first');
    expect(calls[1].task).toBe('use a done');
  });

  it('substitutes {outputs.<name>} from a prior named step', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'planner', task: 'plan', name: 'plan' },
      { agent: 'impl', task: 'execute {outputs.plan}' },
    ];
    await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        return makeAssistantResult(req.agent, 'PLAN-OUT', req.step);
      },
    });

    expect(calls[1].task).toBe('execute PLAN-OUT');
  });

  it('stops with template_error when {outputs.<name>} is unknown', async () => {
    let called = 0;
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'use {outputs.missing}' },
      { agent: 'b', task: 'never' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        called++;
        return makeAssistantResult(req.agent, 'x', req.step);
      },
    });

    expect(called).toBe(0);
    expect(res.isError).toBe(true);
    const last = res.details.results[res.details.results.length - 1];
    expect(last.stopReason).toBe('template_error');
    expect(last.errorMessage).toContain('missing');
  });

  it('stops the chain when a step fails and does not run later steps', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first' },
      { agent: 'b', task: 'second' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        if (req.step === 1) return makeFailureResult(req.agent, req.step, 'boom');
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });

    expect(calls).toHaveLength(1);
    expect(res.isError).toBe(true);
    expect(res.details.results).toHaveLength(1);
  });

  it('stops with template_error after a successful step, preserving prior results', async () => {
    const calls: ChainStepRequest[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'a', task: 'first', name: 'first' },
      { agent: 'b', task: 'use {outputs.missing}' },
      { agent: 'c', task: 'never' },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req);
        return makeAssistantResult(req.agent, `${req.agent} done`, req.step);
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe('a');
    expect(res.isError).toBe(true);
    expect(res.details.results).toHaveLength(2);
    expect(res.details.results[0].agent).toBe('a');
    expect(res.details.results[1].stopReason).toBe('template_error');
  });

  it('parses and validates outputSchema then exposes structuredOutput via outputs', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'list files',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['files'],
          properties: { files: { type: 'array', items: { type: 'string' } } },
        },
      },
      { agent: 'planner', task: 'use {outputs.context}' },
    ];
    let plannerTask = '';
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"files":["a.ts"]}', req.step);
        }
        plannerTask = req.task;
        return makeAssistantResult(req.agent, 'planned', req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(res.details.outputs).toBeDefined();
    expect(res.details.outputs!.context.structured).toEqual({ files: ['a.ts'] });
    expect(plannerTask).toBe('use {"files":["a.ts"]}');
  });

  it('stops with structured_output_error when output fails the schema', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'list files',
        outputSchema: {
          type: 'object',
          required: ['files'],
          properties: { files: { type: 'array', items: { type: 'string' } } },
        },
      },
      { agent: 'planner', task: 'never' },
    ];
    let plannerCalled = false;
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'planner') plannerCalled = true;
        return makeAssistantResult(req.agent, '{}', req.step);
      },
    });

    expect(plannerCalled).toBe(false);
    expect(res.isError).toBe(true);
    const failing = res.details.results[0];
    expect(failing.stopReason).toBe('structured_output_error');
    expect(failing.structuredOutputError).toContain('missing required');
  });

  it('stops with structured_output_error when output is not parseable JSON', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'list files',
        outputSchema: { type: 'object' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, 'no json here', req.step),
    });
    expect(res.isError).toBe(true);
    const failing = res.details.results[0];
    expect(failing.stopReason).toBe('structured_output_error');
    expect(failing.structuredOutputError).toContain('parse');
  });

  it('treats null outputSchema as no schema', async () => {
    let observed = '';
    const chain: ChainItemInput[] = [
      {
        agent: 'a',
        task: 'go',
        outputSchema: null as unknown as Record<string, unknown>,
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        observed = req.task;
        return makeAssistantResult(req.agent, 'plain prose', req.step);
      },
    });
    expect(observed).toBe('go');
    expect(res.isError).toBeUndefined();
  });

  it('fails the step when outputSchema is not an object', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'a',
        task: 'go',
        outputSchema: [] as unknown as Record<string, unknown>,
      },
    ];
    let runStepCalled = false;
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        runStepCalled = true;
        return makeAssistantResult(req.agent, '{}', req.step);
      },
    });
    expect(runStepCalled).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.details.results[0].stopReason).toBe('structured_output_error');
  });

  it('reports a structured_output_error when schema keywords are malformed', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'a',
        task: 'go',
        outputSchema: { enum: 'not-an-array' } as unknown as Record<string, unknown>,
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, '"hello"', req.step),
    });
    expect(res.isError).toBe(true);
    expect(res.details.results[0].stopReason).toBe('structured_output_error');
  });

  it('returns the collected fanout text as the chain final output when fanout is the last step', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        return makeAssistantResult(req.agent, `done ${req.task}`, req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    const final = res.content[0];
    expect(final.type).toBe('text');
    if (final.type === 'text') {
      const parsed = JSON.parse(final.text);
      expect(parsed).toEqual(['done Process a', 'done Process b']);
    }
  });

  it('truncates fanout items to expand.maxItems and notes the skipped count', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' }, maxItems: 1 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.agent === 'explore')
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });
    expect(res.isError).toBeUndefined();
    const entry = res.details.outputs!.results;
    expect(Array.isArray(entry.structured)).toBe(true);
    expect((entry.structured as unknown[]).length).toBe(1);
    expect(entry.text).toContain('skipped 1');
  });

  it('fails fanout when expand.maxItems is not a positive integer', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' }, maxItems: 0 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, '{"items":["a"]}', req.step),
    });
    expect(res.isError).toBe(true);
    expect(res.details.results.at(-1)?.stopReason).toBe('fanout_error');
  });

  it('rejects ambiguous chain steps that mix sequential and fanout fields', async () => {
    const ambiguous = {
      agent: 'explore',
      task: 'mixed',
      expand: { from: { output: 'context', path: '/items' } },
      parallel: { agent: 'worker', task: 'Process {item}' },
      collect: { name: 'results' },
    } as unknown as ChainItemInput;
    const res = await runChainWorkflow({
      chain: [ambiguous],
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, 'ok', req.step),
    });
    expect(res.isError).toBe(true);
    expect(res.details.results[0].stopReason).toBe('fanout_error');
  });

  it('runs fanout over a structured array and collects results', async () => {
    const tasks: string[] = [];
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        tasks.push(req.task);
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        }
        return makeAssistantResult(req.agent, `done ${req.task}`, req.step);
      },
    });

    expect(res.isError).toBeUndefined();
    expect(tasks).toContain('Process a');
    expect(tasks).toContain('Process b');
    expect(res.details.outputs!.results.structured).toHaveLength(2);
  });

  it('stops fanout when JSON Pointer does not resolve to an array', async () => {
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'string' } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => makeAssistantResult(req.agent, '{"items":"nope"}', req.step),
    });

    expect(res.isError).toBe(true);
    expect(res.details.results[1].stopReason).toBe('fanout_error');
  });

  it('runs all fanout subtasks and reports aggregate failure', async () => {
    const calls: string[] = [];
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'find items',
        name: 'context',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'context', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'results' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        calls.push(req.task);
        if (req.agent === 'explore') {
          return makeAssistantResult(req.agent, '{"items":["a","b"]}', req.step);
        }
        if (req.task.endsWith('b')) return makeFailureResult(req.agent, req.step, 'bad b');
        return makeAssistantResult(req.agent, 'ok', req.step);
      },
    });

    expect(calls).toContain('Process a');
    expect(calls).toContain('Process b');
    expect(res.isError).toBe(true);
    const summary = res.content[0];
    expect(summary.type).toBe('text');
    if (summary.type === 'text') expect(summary.text).toContain('Fanout failed: 1/2 succeeded');
  });

  it('appends a JSON-only instruction to tasks that declare outputSchema', async () => {
    let observed = '';
    const chain: ChainItemInput[] = [
      {
        agent: 'explore',
        task: 'base task',
        outputSchema: { type: 'object', required: ['k'], properties: { k: { type: 'string' } } },
      },
    ];
    await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        observed = req.task;
        return makeAssistantResult(req.agent, '{"k":"v"}', req.step);
      },
    });
    expect(observed.startsWith('base task')).toBe(true);
    expect(observed).toContain('IMPORTANT');
    expect(observed).toContain('"required":');
  });
});
