// ABOUTME: Tests for Grok streaming-json parser - text accumulation, stopReason mapping, and end event.
// ABOUTME: Verifies EndTurn->end, Cancelled->max_turns, thought no-op, and invalid JSON handling.

import { describe, expect, it } from 'bun:test';
import type { SingleResult } from '../src/types.ts';
import { parseGrokEvent } from '../src/grok-parser.ts';

function makeResult(model?: string): SingleResult {
  return {
    agent: 'grok-agent',
    agentSource: 'builtin',
    task: 'test',
    exitCode: 0,
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
    model,
    step: undefined,
  };
}

function parseLines(lines: string[], result: SingleResult): number {
  let updateCount = 0;
  const onUpdate = () => {
    updateCount++;
  };
  for (const line of lines) parseGrokEvent(line, result, onUpdate);
  return updateCount;
}

describe('parseGrokEvent text events', () => {
  it('creates an assistant message on first text event', () => {
    const result = makeResult('grok-4.5');
    parseLines([JSON.stringify({ type: 'text', data: 'Hello' })], result);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('appends to existing message on subsequent text events', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'Hello' }),
        JSON.stringify({ type: 'text', data: ' ' }),
        JSON.stringify({ type: 'text', data: 'world' }),
      ],
      result
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('calls onUpdate on each text event', () => {
    const result = makeResult();
    const updates = parseLines(
      [JSON.stringify({ type: 'text', data: 'a' }), JSON.stringify({ type: 'text', data: 'b' })],
      result
    );
    expect(updates).toBe(2);
  });

  it('sets model from result.model on the synthetic message', () => {
    const result = makeResult('grok-4.5');
    parseLines([JSON.stringify({ type: 'text', data: 'hi' })], result);
    expect((result.messages[0] as { model?: string }).model).toBe('grok-4.5');
  });
});

describe('parseGrokEvent end events', () => {
  it('maps EndTurn to end and sets turns to 1', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({ type: 'text', data: 'done' }),
        JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: 's1', requestId: 'r1' }),
      ],
      result
    );
    expect(result.stopReason).toBe('end');
    expect(result.usage.turns).toBe(1);
    expect((result.messages[0] as { stopReason?: string }).stopReason).toBe('end');
  });

  it('maps Cancelled to max_turns', () => {
    const result = makeResult();
    parseLines(
      [JSON.stringify({ type: 'end', stopReason: 'Cancelled', sessionId: 's1', requestId: 'r1' })],
      result
    );
    expect(result.stopReason).toBe('max_turns');
    expect(result.usage.turns).toBe(1);
  });

  it('passes through unknown stopReason values', () => {
    const result = makeResult();
    parseLines(
      [
        JSON.stringify({
          type: 'end',
          stopReason: 'SomethingNew',
          sessionId: 's1',
          requestId: 'r1',
        }),
      ],
      result
    );
    expect(result.stopReason).toBe('SomethingNew');
  });

  it('calls onUpdate on end event', () => {
    const result = makeResult();
    const updates = parseLines([JSON.stringify({ type: 'end', stopReason: 'EndTurn' })], result);
    expect(updates).toBe(1);
  });

  it('creates a synthetic assistant message with stopReason when no text arrived', () => {
    const result = makeResult('grok-4.5');
    parseLines([JSON.stringify({ type: 'end', stopReason: 'EndTurn' })], result);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.messages[0].content).toEqual([]);
    expect((result.messages[0] as { stopReason?: string }).stopReason).toBe('end');
    expect((result.messages[0] as { model?: string }).model).toBe('grok-4.5');
    expect(result.stopReason).toBe('end');
    expect(result.usage.turns).toBe(1);
  });
});

describe('parseGrokEvent thought events', () => {
  it('ignores thought events without creating messages', () => {
    const result = makeResult();
    parseLines([JSON.stringify({ type: 'thought', data: 'thinking...' })], result);
    expect(result.messages).toHaveLength(0);
    expect(result.usage.turns).toBe(0);
  });

  it('does not call onUpdate for thought events', () => {
    const result = makeResult();
    const updates = parseLines([JSON.stringify({ type: 'thought', data: 'hmm' })], result);
    expect(updates).toBe(0);
  });
});

describe('parseGrokEvent edge cases', () => {
  it('ignores empty lines', () => {
    const result = makeResult();
    parseLines(['', '   ', '\t'], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores invalid JSON', () => {
    const result = makeResult();
    parseLines(['not json', '{broken', ''], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores non-object JSON', () => {
    const result = makeResult();
    parseLines(['42', '"string"', 'null', 'true'], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores text events with non-string data', () => {
    const result = makeResult();
    parseLines([JSON.stringify({ type: 'text', data: 123 })], result);
    expect(result.messages).toHaveLength(0);
  });

  it('ignores unknown event types', () => {
    const result = makeResult();
    parseLines([JSON.stringify({ type: 'unknown', data: 'x' })], result);
    expect(result.messages).toHaveLength(0);
  });
});
