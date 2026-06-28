// ABOUTME: Tests for the session-scoped background job manager and notification rendering details.
// ABOUTME: Verifies launch, completion/failure notifications, job limit, and cancelAll().

import { describe, expect, it } from 'bun:test';
import {
  BACKGROUND_MESSAGE_TYPE,
  createBackgroundManager,
  type BackgroundLaunchRequest,
} from '../src/background.ts';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { BackgroundNotificationDetails, SubagentDetails } from '../src/types.ts';

type SentMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: BackgroundNotificationDetails;
  options?: { triggerTurn?: boolean; deliverAs?: string };
};

function makePi() {
  const messages: SentMessage[] = [];
  return {
    messages,
    sendMessage: (msg: Parameters<typeof JSON.stringify>[0], options?: unknown) => {
      const m = msg as Omit<SentMessage, 'options'>;
      messages.push({ ...m, options: options as SentMessage['options'] });
    },
  };
}

function okResult(text: string): AgentToolResult<SubagentDetails> & { isError?: boolean } {
  return {
    content: [{ type: 'text', text }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
    },
  };
}

function errResult(text: string): AgentToolResult<SubagentDetails> & { isError?: boolean } {
  return { ...okResult(text), isError: true };
}

function baseRequest(overrides: Partial<BackgroundLaunchRequest> = {}): BackgroundLaunchRequest {
  return {
    mode: 'single',
    agentScope: 'user',
    description: 'unit job',
    taskPreview: 'Do something useful',
    projectAgentsDir: null,
    run: async () => okResult('all good'),
    ...overrides,
  };
}

describe('createBackgroundManager.launch', () => {
  it('returns launch result immediately and emits a completion notification', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi);

    let resolveRun!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });

    const launchResult = mgr.launch(
      baseRequest({
        run: async () => {
          resolveRun();
          await gate;
          return okResult('finished work');
        },
      })
    );

    expect(launchResult.isError).toBeUndefined();
    expect(launchResult.details?.mode).toBe('background');
    const launches = launchResult.details?.background;
    expect(launches?.length).toBe(1);
    const jobId = launches![0].jobId;
    expect(jobId).toMatch(/^agent-bg-/);
    expect(pi.messages.length).toBe(0);
    expect(mgr.activeCount()).toBe(1);

    await runStarted;
    proceed();
    await mgr.waitForIdle();

    expect(pi.messages.length).toBe(1);
    const msg = pi.messages[0];
    expect(msg.customType).toBe(BACKGROUND_MESSAGE_TYPE);
    expect(msg.options?.triggerTurn).toBe(true);
    expect(msg.options?.deliverAs).toBe('followUp');
    expect(msg.details?.jobId).toBe(jobId);
    expect(msg.details?.status).toBe('completed');
    expect(msg.details?.result).toContain('finished work');
    expect(msg.details?.durationMs).toBeGreaterThanOrEqual(0);
    expect(msg.content).toContain(`jobId="${jobId}"`);
    expect(msg.content).toContain('finished work');
  });

  it('emits a failure notification when the workflow returns isError', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi);
    mgr.launch(baseRequest({ run: async () => errResult('boom') }));
    await mgr.waitForIdle();

    expect(pi.messages.length).toBe(1);
    const msg = pi.messages[0];
    expect(msg.details?.status).toBe('failed');
    expect(msg.details?.error).toContain('boom');
    expect(msg.content).toContain('<error>');
  });

  it('emits a failure notification when the workflow rejects', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi);
    mgr.launch(
      baseRequest({
        run: async () => {
          throw new Error('crashed hard');
        },
      })
    );
    await mgr.waitForIdle();

    expect(pi.messages.length).toBe(1);
    expect(pi.messages[0].details?.status).toBe('failed');
    expect(pi.messages[0].details?.error).toContain('crashed hard');
  });

  it('rejects new launches when the max job limit is reached', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi, { maxJobs: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    mgr.launch(
      baseRequest({
        run: async () => {
          await gate;
          return okResult('ok');
        },
      })
    );
    const blocked = mgr.launch(baseRequest());
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]).toMatchObject({ type: 'text' });
    expect((blocked.content[0] as { text: string }).text).toContain(
      'Too many background agent jobs'
    );

    release();
    await mgr.waitForIdle();
  });

  it('handles a synchronously-throwing run() without leaking job slots', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi, { maxJobs: 1 });
    const launchResult = mgr.launch(
      baseRequest({
        run: () => {
          throw new Error('sync boom');
        },
      })
    );
    expect(launchResult.isError).toBeUndefined();
    await mgr.waitForIdle();
    expect(pi.messages.length).toBe(1);
    expect(pi.messages[0].details?.status).toBe('failed');
    expect(pi.messages[0].details?.error).toContain('sync boom');
    expect(mgr.activeCount()).toBe(0);

    const next = mgr.launch(baseRequest());
    expect(next.isError).toBeUndefined();
    await mgr.waitForIdle();
  });

  it('cancelAll aborts running jobs and marks them cancelled', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi);
    let observedAborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mgr.launch(
      baseRequest({
        run: async (signal) => {
          signal.addEventListener('abort', () => {
            observedAborted = true;
            release();
          });
          await gate;
          return okResult('done after cancel');
        },
      })
    );
    expect(mgr.activeCount()).toBe(1);
    mgr.cancelAll('test');
    await mgr.waitForIdle();
    expect(observedAborted).toBe(true);
    expect(pi.messages.length).toBe(1);
    expect(pi.messages[0].details?.status).toBe('cancelled');
    expect(pi.messages[0].options?.triggerTurn).toBe(false);
  });

  it('cancelAll records the cancellation notification synchronously', async () => {
    const pi = makePi();
    const mgr = createBackgroundManager(pi);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mgr.launch(
      baseRequest({
        run: async () => {
          await gate;
          return okResult('would complete normally');
        },
      })
    );

    expect(pi.messages.length).toBe(0);
    mgr.cancelAll('session_shutdown');
    // Notification must be queued before any microtask drains, so that a host
    // process exiting immediately after session_shutdown still records it.
    expect(pi.messages.length).toBe(1);
    expect(pi.messages[0].details?.status).toBe('cancelled');
    expect(pi.messages[0].options?.triggerTurn).toBe(false);
    expect(mgr.activeCount()).toBe(0);

    // The later run-side finish() must not double-emit.
    release();
    await mgr.waitForIdle();
    expect(pi.messages.length).toBe(1);
  });
});
