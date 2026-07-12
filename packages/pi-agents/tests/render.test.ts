// ABOUTME: Tests for agent tool TUI rendering — update-driven spinner frames and static background status.
// ABOUTME: Uses a fake Theme and row state; no real TUI, timers, or agent subprocesses.

import { describe, expect, it } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import {
  type AgentRenderContext,
  type AgentRenderState,
  clearSpinnerState,
  renderResult,
  runningStatusGlyph,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from '../src/render.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

function fakeTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as Theme;
}

function makeContext(state: AgentRenderState = {}): {
  context: AgentRenderContext;
  state: AgentRenderState;
} {
  return { context: { state }, state };
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 'find things',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { ...emptyUsage },
    ...overrides,
  };
}

function singleDetails(result: SingleResult): SubagentDetails {
  return {
    mode: 'single',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [result],
  };
}

function parallelDetails(results: SingleResult[]): SubagentDetails {
  return {
    mode: 'parallel',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results,
  };
}

function backgroundDetails(): SubagentDetails {
  return {
    mode: 'background',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [],
    background: [
      {
        jobId: 'agent-bg-1',
        mode: 'single',
        status: 'running',
        agentScope: 'user',
        description: 'explore find things',
        startedAt: 0,
        taskPreview: 'find things',
      },
    ],
  };
}

function renderText(component: Component): string {
  return component.render(120).join('\n');
}

describe('runningStatusGlyph', () => {
  it('falls back to hourglass without context', () => {
    expect(runningStatusGlyph(true, undefined)).toBe('⏳');
    expect(runningStatusGlyph(false, undefined)).toBe('⏳');
  });

  it('derives frames from elapsed host time without starting timers', () => {
    const { context, state } = makeContext();
    let now = 1_000_000;
    const clock = () => now;

    expect(runningStatusGlyph(true, context, clock)).toBe(SPINNER_FRAMES[0]);
    expect(state.spinnerStartedAt).toBe(1_000_000);
    // No timer bookkeeping — only the start timestamp.
    expect(Object.keys(state).sort()).toEqual(['spinnerStartedAt']);

    // Same host render window: frame stays put.
    expect(runningStatusGlyph(true, context, clock)).toBe(SPINNER_FRAMES[0]);

    // Next partial render after one frame interval advances the glyph.
    now += SPINNER_INTERVAL_MS;
    expect(runningStatusGlyph(true, context, clock)).toBe(SPINNER_FRAMES[1]);

    now += SPINNER_INTERVAL_MS * 3;
    expect(runningStatusGlyph(true, context, clock)).toBe(SPINNER_FRAMES[4]);

    // Stop path (completion / !running): clear start and return hourglass.
    expect(runningStatusGlyph(false, context, clock)).toBe('⏳');
    expect(state.spinnerStartedAt).toBeUndefined();

    // After stop, further clock advances must not resurrect animation state.
    now += SPINNER_INTERVAL_MS * 50;
    expect(state.spinnerStartedAt).toBeUndefined();
    expect(runningStatusGlyph(false, context, clock)).toBe('⏳');
    expect(state.spinnerStartedAt).toBeUndefined();
  });

  it('restarting after stop begins a new frame sequence', () => {
    const { context, state } = makeContext();
    let now = 5_000;
    const clock = () => now;

    runningStatusGlyph(true, context, clock);
    now += SPINNER_INTERVAL_MS * 5;
    runningStatusGlyph(false, context, clock);
    expect(state.spinnerStartedAt).toBeUndefined();

    now = 50_000;
    expect(runningStatusGlyph(true, context, clock)).toBe(SPINNER_FRAMES[0]);
    expect(state.spinnerStartedAt).toBe(50_000);
  });
});

describe('renderResult spinner', () => {
  const theme = fakeTheme();

  it('animates single partial results across host updates and clears on completion', () => {
    const { context, state } = makeContext();
    let now = 10_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const partial = {
        content: [{ type: 'text', text: 'running' }],
        details: singleDetails(singleResult()),
      };

      const first = renderText(
        renderResult(partial, { expanded: false, isPartial: true }, theme, context)
      );
      expect(first.startsWith(SPINNER_FRAMES[0]!)).toBe(true);
      expect(first).toContain('explore');
      expect(first).not.toContain('⏳');
      expect(state.spinnerStartedAt).toBe(10_000);

      // Simulated host onUpdate (partial result again): elapsed advances frame.
      now += SPINNER_INTERVAL_MS * 2;
      const second = renderText(
        renderResult(partial, { expanded: false, isPartial: true }, theme, context)
      );
      expect(second.startsWith(SPINNER_FRAMES[2]!)).toBe(true);
      expect(state.spinnerStartedAt).toBe(10_000);

      // Final result (isPartial=false): success icon, spinner state cleared.
      const done = renderText(
        renderResult(partial, { expanded: false, isPartial: false }, theme, context)
      );
      expect(done.startsWith('✓')).toBe(true);
      expect(state.spinnerStartedAt).toBeUndefined();

      // Host dropped the row without a terminal render: only startedAt remains,
      // and clearSpinnerState models session_shutdown / explicit teardown.
      // There is never an interval to leak.
      renderResult(partial, { expanded: false, isPartial: true }, theme, context);
      expect(state.spinnerStartedAt).toBeDefined();
      clearSpinnerState(state);
      expect(state.spinnerStartedAt).toBeUndefined();
      now += SPINNER_INTERVAL_MS * 100;
      expect(state.spinnerStartedAt).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it('animates parallel running tasks and clears when all finish', () => {
    const { context, state } = makeContext();
    const realNow = Date.now;
    let now = 20_000;
    Date.now = () => now;
    try {
      const running = {
        content: [{ type: 'text', text: 'parallel' }],
        details: parallelDetails([
          singleResult({ agent: 'a', exitCode: -1 }),
          singleResult({ agent: 'b', exitCode: -1 }),
        ]),
      };

      const text = renderText(
        renderResult(running, { expanded: false, isPartial: true }, theme, context)
      );
      expect(text.startsWith(SPINNER_FRAMES[0]!)).toBe(true);
      expect(text).toContain('0/2 done, 2 running');
      expect(text).toContain('(running...)');
      const glyph = SPINNER_FRAMES[0]!;
      expect(text.split(glyph).length - 1).toBeGreaterThanOrEqual(3);
      expect(state.spinnerStartedAt).toBeDefined();

      now += SPINNER_INTERVAL_MS;
      const advanced = renderText(
        renderResult(running, { expanded: false, isPartial: true }, theme, context)
      );
      expect(advanced.startsWith(SPINNER_FRAMES[1]!)).toBe(true);

      const finished = {
        content: [{ type: 'text', text: 'done' }],
        details: parallelDetails([
          singleResult({ agent: 'a', exitCode: 0 }),
          singleResult({ agent: 'b', exitCode: 0 }),
        ]),
      };
      const done = renderText(
        renderResult(finished, { expanded: false, isPartial: false }, theme, context)
      );
      expect(done.startsWith('✓')).toBe(true);
      expect(done).toContain('2/2 tasks');
      expect(state.spinnerStartedAt).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it('clears spinner state on error finalization (abort-like terminal path)', () => {
    const { context, state } = makeContext();
    const realNow = Date.now;
    Date.now = () => 30_000;
    try {
      const partial = {
        content: [{ type: 'text', text: 'running' }],
        details: singleDetails(singleResult()),
      };
      renderResult(partial, { expanded: false, isPartial: true }, theme, context);
      expect(state.spinnerStartedAt).toBeDefined();

      const failed = {
        content: [{ type: 'text', text: 'failed' }],
        details: singleDetails(
          singleResult({ exitCode: 1, stopReason: 'aborted', errorMessage: 'aborted' })
        ),
      };
      const text = renderText(
        renderResult(failed, { expanded: false, isPartial: false }, theme, context)
      );
      expect(text.startsWith('✗')).toBe(true);
      expect(state.spinnerStartedAt).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it('clears spinner state when renderer falls through to empty/unknown result', () => {
    const { context, state } = makeContext();
    state.spinnerStartedAt = 1;
    renderResult(
      { content: [{ type: 'text', text: 'none' }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      context
    );
    expect(state.spinnerStartedAt).toBeUndefined();
  });

  it('keeps a static hourglass for background launches and never starts spinner state', () => {
    const { context, state } = makeContext();

    const text = renderText(
      renderResult(
        {
          content: [{ type: 'text', text: 'launched' }],
          details: backgroundDetails(),
        },
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );

    expect(text).toContain('⏳');
    expect(text).toContain('background');
    expect(text).toContain('agent-bg-1');
    expect(text).toContain('You will be notified when it completes.');
    expect(state.spinnerStartedAt).toBeUndefined();
    for (const frame of SPINNER_FRAMES) {
      expect(text.includes(frame)).toBe(false);
    }
  });

  it('clears a prior running marker when rendering background result', () => {
    const { context, state } = makeContext();
    state.spinnerStartedAt = 99;
    renderResult(
      {
        content: [{ type: 'text', text: 'launched' }],
        details: backgroundDetails(),
      },
      { expanded: false, isPartial: false },
      theme,
      context
    );
    expect(state.spinnerStartedAt).toBeUndefined();
  });

  it('does not install intervals — wall wait after partial render is idle', async () => {
    const { context, state } = makeContext();
    const realNow = Date.now;
    Date.now = () => 40_000;
    try {
      renderResult(
        {
          content: [{ type: 'text', text: 'running' }],
          details: singleDetails(singleResult()),
        },
        { expanded: false, isPartial: true },
        theme,
        context
      );
      expect(state.spinnerStartedAt).toBe(40_000);
      const startedAt = state.spinnerStartedAt;

      await new Promise((r) => setTimeout(r, SPINNER_INTERVAL_MS + 40));
      // No background tick mutates state while the host is idle.
      expect(state.spinnerStartedAt).toBe(startedAt);
      expect(Object.keys(state)).toEqual(['spinnerStartedAt']);
    } finally {
      Date.now = realNow;
    }
  });
});
