// ABOUTME: Tests for output helpers — token formatting, final output extraction, and byte-safe truncation.
// ABOUTME: Pure unit tests; no spawned processes or filesystem state.

import { describe, expect, it } from 'bun:test';
import type { Message } from '@earendil-works/pi-ai';
import { PER_TASK_OUTPUT_CAP } from '../src/constants.ts';
import {
  formatAggregateUsageStats,
  formatTokens,
  formatUsageStats,
  getFinalOutput,
  getLatestActivity,
  getTranscriptAndFinal,
  resolveExecutionStatus,
  truncateParallelOutput,
} from '../src/output.ts';
import type { SingleResult } from '../src/types.ts';

function assistantText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as Message;
}

function assistantTool(name: string, args: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name, arguments: args }],
  } as unknown as Message;
}

function assistantMixed(
  parts: Array<{ type: 'text'; text: string } | { type: 'toolCall'; name: string; args?: object }>
): Message {
  return {
    role: 'assistant',
    content: parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'toolCall', name: p.name, arguments: p.args ?? {} }
    ),
  } as unknown as Message;
}

describe('formatTokens', () => {
  it('returns plain digits below 1k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with one decimal under 10k', () => {
    expect(formatTokens(1500)).toBe('1.5k');
  });

  it('formats millions with one decimal', () => {
    expect(formatTokens(1500000)).toBe('1.5M');
  });
});

describe('getFinalOutput', () => {
  it('returns the first text part from the latest assistant message', () => {
    const messages: Message[] = [
      assistantText('first'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'noise' }],
      } as unknown as Message,
      assistantMixed([
        { type: 'text', text: 'older' },
        { type: 'text', text: 'final' },
      ]),
    ];
    expect(getFinalOutput(messages)).toBe('older');
  });

  it('returns empty string when no assistant text exists', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      } as unknown as Message,
    ];
    expect(getFinalOutput(messages)).toBe('');
    expect(getFinalOutput([])).toBe('');
  });
});

describe('getLatestActivity', () => {
  it('returns undefined for empty messages', () => {
    expect(getLatestActivity([])).toBeUndefined();
  });

  it('returns the last tool call', () => {
    const messages = [
      assistantTool('read', { path: 'a.ts' }),
      assistantTool('bash', { command: 'ls' }),
    ];
    expect(getLatestActivity(messages)).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'ls' },
    });
  });

  it('returns the last assistant text', () => {
    const messages = [assistantText('hello'), assistantText('world')];
    expect(getLatestActivity(messages)).toEqual({ type: 'text', text: 'world' });
  });

  it('follows interleaved tool and text order', () => {
    const messages = [
      assistantTool('read', { path: 'a' }),
      assistantText('mid'),
      assistantTool('grep', { pattern: 'x' }),
    ];
    const latest = getLatestActivity(messages);
    expect(latest?.type).toBe('toolCall');
    if (latest?.type === 'toolCall') expect(latest.name).toBe('grep');
  });

  it('selects the last content part within the last assistant message', () => {
    const messages = [
      assistantMixed([
        { type: 'text', text: 'earlier' },
        { type: 'toolCall', name: 'bash', args: { command: 'echo' } },
      ]),
    ];
    const latest = getLatestActivity(messages);
    expect(latest).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'echo' },
    });
  });
});

describe('getTranscriptAndFinal', () => {
  it('returns empty transcript and final for empty messages', () => {
    expect(getTranscriptAndFinal([])).toEqual({ transcript: [], finalOutput: '' });
  });

  it('excludes the final assistant text from the transcript', () => {
    const messages = [
      assistantTool('read', { path: 'a.ts' }),
      assistantText('thinking aloud'),
      assistantMixed([
        { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
        { type: 'text', text: 'done' },
      ]),
    ];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('done');
    expect(transcript).toEqual([
      { type: 'toolCall', name: 'read', args: { path: 'a.ts' } },
      { type: 'text', text: 'thinking aloud' },
      { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
    ]);
    // Final text appears exactly once overall (as finalOutput, not in transcript)
    const textParts = transcript.filter((i) => i.type === 'text');
    expect(textParts.some((t) => t.type === 'text' && t.text === 'done')).toBe(false);
  });

  it('preserves earlier assistant text blocks', () => {
    const messages = [
      assistantText('turn 1 notes'),
      assistantText('turn 2 notes'),
      assistantText('final answer'),
    ];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('final answer');
    expect(transcript).toEqual([
      { type: 'text', text: 'turn 1 notes' },
      { type: 'text', text: 'turn 2 notes' },
    ]);
  });

  it('keeps all items when there is no final text', () => {
    const messages = [assistantTool('read', { path: 'x' })];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('');
    expect(transcript).toHaveLength(1);
  });

  it('does not duplicate final text when a trailing assistant message is tool-only', () => {
    const messages = [assistantText('final answer'), assistantTool('read', { path: 'late.ts' })];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('final answer');
    expect(transcript).toEqual([{ type: 'toolCall', name: 'read', args: { path: 'late.ts' } }]);
    expect(transcript.some((i) => i.type === 'text' && i.text === 'final answer')).toBe(false);
  });
});

describe('resolveExecutionStatus', () => {
  it('prefers explicit status', () => {
    const r = { status: 'running', exitCode: 0 } as SingleResult;
    expect(resolveExecutionStatus(r)).toBe('running');
  });

  it('falls back from exitCode for older sessions', () => {
    expect(resolveExecutionStatus({ exitCode: -1 } as SingleResult)).toBe('running');
    expect(resolveExecutionStatus({ exitCode: 0 } as SingleResult)).toBe('completed');
    expect(resolveExecutionStatus({ exitCode: 1 } as SingleResult)).toBe('failed');
    expect(resolveExecutionStatus({ exitCode: 1, stopReason: 'aborted' } as SingleResult)).toBe(
      'cancelled'
    );
  });
});

describe('formatUsageStats', () => {
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };

  it('appends model when provided', () => {
    expect(formatUsageStats(emptyUsage, 'glm-5.2')).toBe('glm-5.2');
  });

  it('appends thinking level next to model when provided', () => {
    expect(formatUsageStats(emptyUsage, 'glm-5.2', 'xhigh')).toBe('glm-5.2 • xhigh');
  });

  it('omits thinking when model is missing', () => {
    expect(formatUsageStats(emptyUsage, undefined, 'xhigh')).toBe('');
  });

  it('shows only mid-turn fields (ctx) without zero token breakdown', () => {
    expect(
      formatUsageStats({
        ...emptyUsage,
        cost: 0.0123,
        contextTokens: 111,
      })
    ).toBe('ctx:111');
  });

  it('omits cost from display even when present', () => {
    expect(
      formatUsageStats({
        ...emptyUsage,
        cost: 0.0123,
      })
    ).toBe('');
  });

  it('shows context alone when that is the only known field', () => {
    expect(formatUsageStats({ ...emptyUsage, contextTokens: 50 })).toBe('ctx:50');
  });

  it('shows the full breakdown when all fields are present', () => {
    expect(
      formatUsageStats(
        {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          cost: 0.0123,
          contextTokens: 17,
          turns: 1,
        },
        'fake-model',
        'high'
      )
    ).toBe('1 turn ↑10 ↓4 R2 W1 ctx:17 fake-model • high');
  });
});

describe('formatAggregateUsageStats', () => {
  it('formats max context and omits model/thinking', () => {
    expect(
      formatAggregateUsageStats({
        input: 20,
        output: 3,
        cacheRead: 40,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 12000,
        turns: 9,
      })
    ).toBe('9 turns ↑20 ↓3 R40 ctx:max 12k');
  });
});

describe('truncateParallelOutput', () => {
  it('preserves strings under the cap', () => {
    const small = 'hello world';
    expect(truncateParallelOutput(small)).toBe(small);
  });

  it('truncates oversize strings and keeps the pre-notice body within the cap', () => {
    const big = 'a'.repeat(PER_TASK_OUTPUT_CAP + 1024);
    const result = truncateParallelOutput(big);
    const noticeIdx = result.indexOf('\n\n[Output truncated:');
    expect(noticeIdx).toBeGreaterThan(-1);
    const preNotice = result.slice(0, noticeIdx);
    expect(Buffer.byteLength(preNotice, 'utf8')).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
    expect(result).toContain('[Output truncated:');
  });
});

describe('cloneSingleResult deep snapshot', () => {
  it('isolates message content and tool arguments from later mutation', async () => {
    const { cloneSingleResult, emptyUsage } = await import('../src/types.ts');
    const args = { path: 'original.ts' };
    const result: SingleResult = {
      agent: 'explore',
      agentSource: 'user',
      task: 't',
      exitCode: -1,
      status: 'running',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: args }],
        } as unknown as SingleResult['messages'][number],
      ],
      stderr: '',
      usage: { ...emptyUsage(), input: 1 },
    };
    const snap = cloneSingleResult(result);
    // Mutate live result the way a streaming parser would.
    args.path = 'mutated.ts';
    result.usage.input = 999;
    const livePart = result.messages[0].content[0] as unknown as {
      arguments: { path: string };
    };
    livePart.arguments.path = 'mutated.ts';
    const snapPart = snap.messages[0].content[0] as unknown as {
      arguments: { path: string };
    };
    expect(snapPart.arguments.path).toBe('original.ts');
    expect(snap.usage.input).toBe(1);
  });
});
