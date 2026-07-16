// ABOUTME: Synthetic end-to-end memory regressions for compact parent/durable results.
// ABOUTME: Asserts raw tool-result bodies stay out of parent details while final output is preserved.

import { describe, expect, it } from 'bun:test';
import {
  INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES,
  MAX_PARALLEL_TASKS,
  RESULT_UPDATE_INTERVAL_MS,
} from '../src/constants.ts';
import { snapshotResults, snapshotSingleResult } from '../src/result-snapshot.ts';
import type { SingleResult } from '../src/types.ts';
import { emptyUsage } from '../src/types.ts';
import { createLatestValueCoalescer } from '../src/update-coalescer.ts';

function assistant(text: string, toolName?: string): SingleResult['messages'][number] {
  if (toolName) {
    return {
      role: 'assistant',
      content: [
        { type: 'toolCall', name: toolName, arguments: { path: 'file.ts' } },
        { type: 'text', text },
      ],
    } as never;
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as never;
}

function toolResult(body: string): SingleResult['messages'][number] {
  return {
    role: 'toolResult',
    toolCallId: 'tc',
    toolName: 'bash',
    content: [{ type: 'text', text: body }],
    isError: false,
  } as never;
}

function base(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    status: 'completed',
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    ...overrides,
  };
}

describe('memory regressions', () => {
  it('100-turn synthetic stream excludes raw tool bodies from parent snapshot', () => {
    const body = 'T'.repeat(64 * 1024);
    const messages: SingleResult['messages'] = [];
    for (let i = 0; i < 100; i++) {
      messages.push(assistant(`turn ${i} note`, 'read'));
      messages.push(toolResult(body));
    }
    messages.push(assistant('FINAL_ANSWER'));
    const snap = snapshotSingleResult(base({ messages, finalOutput: 'FINAL_ANSWER' }));
    const json = JSON.stringify(snap);
    expect(json).not.toContain('T'.repeat(64));
    expect(snap.messages).toEqual([]);
    expect(snap.finalOutput).toBe('FINAL_ANSWER');
    expect(snap.presentation?.transcript.some((i) => i.type === 'toolCall')).toBe(true);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(2 * 1024 * 1024);
  });

  it('eight-item fanout details stay compact and early shells stay isolated', () => {
    const body = 'R'.repeat(64 * 1024);
    const results: SingleResult[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        snapshotSingleResult(
          base({
            task: `item ${i}`,
            messages: [assistant(`note ${i}`, 'bash'), toolResult(body), assistant(`done ${i}`)],
            finalOutput: `done ${i}`,
            structuredOutput: { i },
            fanout: { index: i, count: 8 },
            unitId: `u-${i}`,
            sessionFile: `/tmp/s-${i}.jsonl`,
          })
        )
      );
    }
    const details = { mode: 'parallel', results: snapshotResults(results) };
    const json = JSON.stringify(details);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(2 * 1024 * 1024);
    expect(json).not.toContain('R'.repeat(64));
    for (const r of details.results) {
      expect(r.finalOutput?.startsWith('done ')).toBe(true);
      expect(r.structuredOutput).toBeDefined();
      expect(r.sessionFile).toBeDefined();
      expect(r.messages).toEqual([]);
    }

    // Early retained shell isolation via CoW helper path is covered in CoW tests;
    // here assert snapshotResults order and identity of structured payloads after freeze.
    const first = details.results[0]!;
    const clone = snapshotSingleResult(first);
    expect(clone.presentation).toBe(first.presentation);
    expect(clone.structuredOutput).toBe(first.structuredOutput);
  });

  it('coalescer with deferred timer emits once for 1000 schedules', () => {
    let handler: (() => void) | undefined;
    const emitted: number[] = [];
    const c = createLatestValueCoalescer<number>(
      (v) => emitted.push(v),
      RESULT_UPDATE_INTERVAL_MS,
      {
        setTimeout(h) {
          handler = h;
          return 1;
        },
        clearTimeout() {
          handler = undefined;
        },
      }
    );
    for (let i = 0; i < 1000; i++) c.schedule(i);
    expect(emitted).toEqual([]);
    handler?.();
    expect(emitted).toEqual([999]);
  });

  it('documents idle interactive budget constant relationship', () => {
    // Warm idle retention ceiling used by Task 7/8 docs.
    expect(MAX_PARALLEL_TASKS).toBe(8);
    expect(INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES).toBe(512 * 1024);
    expect(MAX_PARALLEL_TASKS * INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES).toBeGreaterThan(0);
  });
});
