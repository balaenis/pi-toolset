// ABOUTME: Regression tests for native pi-schema agent parameters.
// ABOUTME: Checks permissive inputs, strict validation, and Pi argument coercion.

import { describe, expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { compile } from '@earendil-works/pi-schema';
import { ChainItem, FanoutChainItem, SubagentParams, TaskItem } from '../../src/shared/schema.ts';

const task = { agent: 'general', task: 'Inspect the project' };
const tool = { name: 'agent', description: 'Delegate a task', parameters: SubagentParams };

describe('native agent schemas', () => {
  it('keeps unknown properties at every nested object boundary', () => {
    const fanout = {
      expand: {
        from: { output: 'items', path: '/items', extra: true },
        extra: true,
      },
      parallel: { ...task, extra: true },
      collect: { name: 'results', extra: true },
      extra: true,
    };
    const input = {
      tasks: [{ ...task, extra: true }],
      chain: [{ ...task, outputSchema: { type: 'object' }, extra: true }, fanout],
      extra: true,
    };

    expect(compile(SubagentParams).check(input)).toBe(true);
    expect(compile(FanoutChainItem).check(fanout)).toBe(true);
  });

  it('requires task fields and rejects invalid types without coercion', () => {
    const validator = compile(TaskItem);

    expect(validator.check(task)).toBe(true);
    expect(validator.check({ agent: task.agent })).toBe(false);
    expect(validator.check({ ...task, task: false })).toBe(false);
    expect(validator.check({ ...task, isolation: 'invalid' })).toBe(false);
    expect(validator.errors({ agent: task.agent })).toContainEqual({
      path: '/task',
      keyword: 'required',
      message: 'missing',
    });
  });

  it('retains arbitrary output schema values and optional fields', () => {
    const validator = compile(ChainItem);

    expect(validator.check({ ...task, title: undefined, outputSchema: null })).toBe(true);
    expect(validator.check({ ...task, outputSchema: { type: 'array', items: {} } })).toBe(true);
    expect(compile(SubagentParams).check({})).toBe(true);
  });

  it('uses Pi validation with native schemas and retains coerced values', () => {
    const input = { ...task, runInBackground: 'false', runtime: 'pi', extra: true };
    const result = validateToolArguments(tool, {
      type: 'toolCall',
      id: 'schema-test',
      name: tool.name,
      arguments: input,
    });

    expect(result).toEqual({ ...input, runInBackground: false });
    expect(input.runInBackground).toBe('false');
  });

  it('reports invalid native schema arguments through Pi', () => {
    expect(() =>
      validateToolArguments(tool, {
        type: 'toolCall',
        id: 'schema-test',
        name: tool.name,
        arguments: { ...task, runtime: 'invalid' },
      })
    ).toThrow('runtime:');
  });
});
