// ABOUTME: Tests agent tool TUI rendering for compact collapse and complete expanded layouts.
// ABOUTME: Uses fake renderer contexts without agent subprocesses.

import { describe, expect, it } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import {
  type AgentRenderState,
  type AgentToolRenderContext,
  renderCall,
  renderResult,
  RUNNING_STATUS_GLYPH,
} from '../src/render.ts';
import type { ChainExecutionDetails, SingleResult, SubagentDetails } from '../src/types.ts';
import { emptyUsage } from '../src/types.ts';

function fakeTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as Theme;
}

let nextToolCallId = 0;

function makeContext(
  state: AgentRenderState = {},
  invalidate: () => void = () => {}
): {
  context: AgentToolRenderContext;
  state: AgentRenderState;
} {
  const context = {
    toolCallId: `tool-${nextToolCallId++}`,
    state,
    invalidate,
  } as AgentToolRenderContext;
  return { context, state };
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 'find things',
    exitCode: 0,
    status: 'completed',
    messages: [],
    stderr: '',
    usage: { ...emptyUsage() },
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

function chainDetails(results: SingleResult[], chain: ChainExecutionDetails): SubagentDetails {
  return {
    mode: 'chain',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results,
    chain,
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

function assistantMessages(
  items: Array<{ type: 'text'; text: string } | { type: 'toolCall'; name: string; path?: string }>
): SingleResult['messages'] {
  return items.map((item) => {
    if (item.type === 'text') {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: item.text }],
      } as unknown as SingleResult['messages'][number];
    }
    return {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          name: item.name,
          arguments: { path: item.path ?? 'file.ts' },
        },
      ],
    } as unknown as SingleResult['messages'][number];
  });
}

function renderText(component: Component, width = 120): string {
  return component.render(width).join('\n');
}

describe('RUNNING_STATUS_GLYPH', () => {
  it('is the static hourglass-with-bars glyph', () => {
    expect(RUNNING_STATUS_GLYPH).toBe('⧗');
  });
});

describe('renderCall', () => {
  it('returns a zero-line component without the subagent title', () => {
    const theme = fakeTheme();
    const text = renderText(renderCall({ agent: 'explore', task: 'look around' }, theme));
    expect(text.trim()).toBe('');
    expect(text).not.toContain('subagent');
  });
});

describe('renderResult single', () => {
  const theme = fakeTheme();

  it('shows compact running summary with one latest activity', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'running',
      exitCode: -1,
      task: '探索当前项目的整体结构',
      model: 'grok-4.5',
      thinking: 'high',
      usage: {
        ...emptyUsage(),
        turns: 9,
        input: 20000,
        output: 6500,
        cacheRead: 148000,
        contextTokens: 9400,
      },
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: { path: '/home/x/.gitignore' } }],
        } as unknown as SingleResult['messages'][number],
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'ls -la' } }],
        } as unknown as SingleResult['messages'][number],
      ],
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'running' }], details: singleDetails(r) },
        { expanded: false, isPartial: true },
        theme,
        context
      )
    );
    expect(text).toContain(RUNNING_STATUS_GLYPH);
    expect(text).toContain('explore');
    expect(text).toContain('9 turns');
    expect(text).toContain('grok-4.5');
    expect(text).toContain('└');
    expect(text).toContain('ls -la');
    expect(text).not.toContain('.gitignore'); // only latest activity
    expect(text).toContain('(Ctrl+O to expand)');
    expect(text).not.toContain('subagent');
  });

  it('hides latest activity and final output when completed', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      task: 'done task',
      model: 'grok-4.5',
      thinking: 'high',
      usage: { ...emptyUsage(), turns: 3, input: 100, output: 50 },
      messages: assistantMessages([
        { type: 'toolCall', name: 'read', path: 'a.ts' },
        { type: 'text', text: 'final answer body' },
      ]),
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );
    expect(text.startsWith('✔')).toBe(true);
    expect(text).not.toContain('└');
    expect(text).not.toContain('final answer body');
    expect(text).toContain('(Ctrl+O to expand)');
  });

  it('shows error icon and message on failed results', () => {
    const { context } = makeContext();
    const text = renderText(
      renderResult(
        {
          content: [{ type: 'text', text: 'failed' }],
          details: singleDetails(
            singleResult({
              status: 'failed',
              exitCode: 1,
              stopReason: 'aborted',
              errorMessage: 'aborted',
            })
          ),
        },
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );
    // aborted with status failed uses ✗ when status is failed; cancelled uses ⊘
    expect(text.startsWith('✗') || text.startsWith('⊘')).toBe(true);
    expect(text).toContain('Error: aborted');
  });

  it('shows cancelled glyph', () => {
    const { context } = makeContext();
    const text = renderText(
      renderResult(
        {
          content: [{ type: 'text', text: 'cancel' }],
          details: singleDetails(
            singleResult({
              status: 'cancelled',
              exitCode: 1,
              stopReason: 'aborted',
            })
          ),
        },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('⊘');
  });

  it('expanded view includes task, transcript, and final once', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      agentSource: 'builtin',
      task: 'full task description here',
      messages: assistantMessages([
        { type: 'toolCall', name: 'read', path: 'a.ts' },
        { type: 'text', text: 'earlier note' },
        { type: 'text', text: 'final answer' },
      ]),
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: true },
        theme,
        context
      )
    );
    expect(text.trimStart().startsWith('─── Task ───')).toBe(true);
    expect(text).not.toContain('(builtin)');
    expect(text).toContain('full task description here');
    expect(text).toContain('─── Output ───');
    expect(text).toContain('read');
    expect(text).toContain('earlier note');
    expect(text).toContain('─── Final ───');
    expect(text).toContain('final answer');
    // Final should appear once as a dedicated section; count occurrences of exact final string in body
    const finalCount = text.split('final answer').length - 1;
    expect(finalCount).toBe(1);
  });

  it('truncates long task preview before dropping usage on narrow width', () => {
    const { context } = makeContext();
    const longTask =
      '探索当前项目的整体结构包括目录布局主要文件配置文件源码组织方式技术栈以及依赖关系图';
    const r = singleResult({
      status: 'completed',
      task: longTask,
      model: 'grok-4.5',
      thinking: 'high',
      usage: { ...emptyUsage(), turns: 9, input: 20000, output: 6500 },
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false },
        theme,
        context
      ),
      50
    );
    expect(text).toContain('explore');
    expect(text).toContain('9 turns');
    expect(text).toMatch(/\.\.\./);
  });

  it('uses terminal column width for CJK task previews (not string.length)', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const { context } = makeContext();
    const r = singleResult({
      status: 'running',
      task: '你好世界测试截断宽度',
      model: 'm',
      usage: { ...emptyUsage(), turns: 1 },
    });
    const width = 28;
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'run' }], details: singleDetails(r) },
        { expanded: false, isPartial: true },
        theme,
        context
      ),
      width
    );
    const firstLine = text.split('\n')[0] ?? '';
    expect(visibleWidth(firstLine)).toBeLessThanOrEqual(width);
    expect(firstLine).toContain('explore');
    expect(firstLine).toContain(RUNNING_STATUS_GLYPH);
  });
});

describe('renderResult parallel', () => {
  const theme = fakeTheme();

  it('shows one summary per task and latest only under running tasks', () => {
    const { context } = makeContext();
    const details = parallelDetails([
      singleResult({
        agent: 'explore',
        status: 'completed',
        task: 'done task',
        usage: { ...emptyUsage(), turns: 5, input: 12 },
      }),
      singleResult({
        agent: 'reviewer',
        status: 'running',
        exitCode: -1,
        task: 'review models',
        messages: assistantMessages([{ type: 'toolCall', name: 'read', path: 'models.rs' }]),
        usage: { ...emptyUsage(), turns: 4, input: 8 },
      }),
      singleResult({
        agent: 'worker',
        status: 'queued',
        exitCode: -1,
        task: 'waiting',
      }),
    ]);
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'parallel' }], details },
        { expanded: false, isPartial: true },
        theme,
        context
      )
    );
    expect(text).toContain('explore');
    expect(text).toContain('reviewer');
    expect(text).toContain('worker');
    expect(text).toContain('└');
    expect(text).toContain('read');
    expect(text).toContain('Total:');
    expect(text).toContain('1/3 completed');
    expect(text).toContain('(Ctrl+O to expand)');
    // completed and queued should not show activity lines with tool names beyond the one running
    const activityLines = text.split('\n').filter((l) => l.includes('└'));
    expect(activityLines).toHaveLength(1);
  });

  it('aggregate usage uses ctx:max and omits model', () => {
    const { context } = makeContext();
    const details = parallelDetails([
      singleResult({
        agent: 'a',
        status: 'completed',
        model: 'm1',
        thinking: 'high',
        usage: { ...emptyUsage(), turns: 2, input: 10, contextTokens: 5000 },
      }),
      singleResult({
        agent: 'b',
        status: 'completed',
        model: 'm2',
        usage: { ...emptyUsage(), turns: 3, input: 20, contextTokens: 12000 },
      }),
    ]);
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('ctx:max');
    // Aggregate footer should not append model names after Total
    const totalLine = text.split('\n').find((l) => l.startsWith('Total:'));
    expect(totalLine).toBeDefined();
    expect(totalLine).not.toContain('m1');
    expect(totalLine).not.toContain('m2');
  });

  it('allows expanded layout while tasks are still running', () => {
    const { context } = makeContext();
    const details = parallelDetails([
      singleResult({
        agent: 'a',
        status: 'completed',
        task: 't1',
        usage: { ...emptyUsage(), turns: 1 },
      }),
      singleResult({
        agent: 'b',
        status: 'running',
        exitCode: -1,
        task: 't2',
        messages: assistantMessages([{ type: 'text', text: 'still going' }]),
        usage: { ...emptyUsage(), turns: 1 },
      }),
    ]);
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'parallel' }], details },
        { expanded: true, isPartial: true },
        theme,
        context
      )
    );
    expect(text.trimStart().startsWith('─── Task ───')).toBe(true);
    expect(text).not.toMatch(/^parallel /i);
    expect(text).toContain('✔ a');
    expect(text).toContain('⧗ b');
    expect(text).toContain('─── Task ───');
    expect(text).toContain('t1');
    expect(text).toContain('t2');
  });
});

describe('renderResult chain', () => {
  const theme = fakeTheme();

  it('shows sequential steps with latest only on the active step', () => {
    const { context } = makeContext();
    const results = [
      singleResult({
        agent: 'explore',
        status: 'completed',
        step: 1,
        task: 'analyze',
        usage: { ...emptyUsage(), turns: 5 },
      }),
      singleResult({
        agent: 'planner',
        status: 'running',
        exitCode: -1,
        step: 2,
        task: 'plan',
        messages: assistantMessages([{ type: 'toolCall', name: 'read', path: 'docs/spec.md' }]),
        usage: { ...emptyUsage(), turns: 4 },
      }),
    ];
    const chain: ChainExecutionDetails = {
      totalSteps: 3,
      steps: [
        { kind: 'sequential', step: 1, agent: 'explore', task: 'analyze', status: 'completed' },
        { kind: 'sequential', step: 2, agent: 'planner', task: 'plan', status: 'running' },
        { kind: 'sequential', step: 3, agent: 'worker', task: 'impl', status: 'queued' },
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'chain' }], details: chainDetails(results, chain) },
        { expanded: false, isPartial: true },
        theme,
        context
      )
    );
    expect(text).toContain('1. explore');
    expect(text).toContain('2. planner');
    expect(text).not.toContain('3. worker'); // queued omitted
    expect(text).toContain('└');
    expect(text).toContain('read');
    expect(text).toContain('Chain: step 2/3');
    expect(text).toContain('1 completed');
    const activityLines = text.split('\n').filter((l) => l.includes('└'));
    expect(activityLines).toHaveLength(1);
  });

  it('renders fanout as one logical step with one latest activity', () => {
    const { context } = makeContext();
    const fanoutItems = [0, 1, 2].map((index) =>
      singleResult({
        agent: 'reviewer',
        status: index === 2 ? 'running' : 'completed',
        exitCode: index === 2 ? -1 : 0,
        step: 2,
        task: `review item ${index}`,
        fanout: { index, count: 3, itemTask: `review item ${index}` },
        messages:
          index === 2
            ? assistantMessages([{ type: 'toolCall', name: 'read', path: 'src/models.ts' }])
            : [],
        usage: { ...emptyUsage(), turns: 2, input: 4 },
      })
    );
    const results = [
      singleResult({
        agent: 'planner',
        status: 'completed',
        step: 1,
        task: 'generate targets',
        usage: { ...emptyUsage(), turns: 4 },
      }),
      ...fanoutItems,
    ];
    const chain: ChainExecutionDetails = {
      totalSteps: 3,
      steps: [
        {
          kind: 'sequential',
          step: 1,
          agent: 'planner',
          task: 'generate targets',
          status: 'completed',
        },
        {
          kind: 'fanout',
          step: 2,
          agent: 'reviewer',
          taskTemplate: '审查每个目标',
          status: 'running',
          collectName: 'reviews',
          executedCount: 3,
          completedCount: 2,
          failedCount: 0,
          runningCount: 1,
          queuedCount: 0,
          skippedCount: 0,
          latestIndex: 2,
        },
        { kind: 'sequential', step: 3, agent: 'worker', task: 'merge', status: 'queued' },
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'chain' }], details: chainDetails(results, chain) },
        { expanded: false, isPartial: true },
        theme,
        context
      )
    );
    expect(text).toContain('1. planner');
    expect(text).toContain('2. reviewer fanout');
    expect(text).toContain('2/3 done');
    expect(text).toContain('[3/3]');
    expect(text).toContain('read');
    // Should not list every fanout item as its own summary line
    expect(text).not.toContain('review item 0');
    expect(text).toContain('Chain: step 2/3');
  });

  it('expanded fanout lists each item and collect metadata', () => {
    const { context } = makeContext();
    const items = [0, 1].map((index) =>
      singleResult({
        agent: 'reviewer',
        status: 'completed',
        step: 1,
        task: `item ${index}`,
        fanout: { index, count: 2, itemTask: `item ${index}` },
        messages: assistantMessages([{ type: 'text', text: `out ${index}` }]),
        usage: { ...emptyUsage(), turns: 1 },
      })
    );
    const details: SubagentDetails = {
      ...chainDetails(items, {
        totalSteps: 1,
        steps: [
          {
            kind: 'fanout',
            step: 1,
            agent: 'reviewer',
            taskTemplate: 'review {item}',
            status: 'completed',
            sourceOutput: 'plan',
            sourcePath: '/items',
            collectName: 'reviews',
            concurrency: 2,
            executedCount: 2,
            completedCount: 2,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 1,
          },
        ],
      }),
      outputs: {
        reviews: {
          text: '["out 0","out 1"]',
          structured: ['out 0', 'out 1'],
          agent: 'reviewer',
          step: 1,
        },
      },
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'chain' }], details },
        { expanded: true },
        theme,
        context
      )
    );
    expect(text.trimStart().startsWith('─── Fanout step 1 ───')).toBe(true);
    expect(text).not.toMatch(/^chain /i);
    expect(text).toContain('✔ reviewer');
    expect(text).toContain('Fanout');
    expect(text).toContain('expand: plan/items');
    expect(text).toContain('collect: reviews');
    expect(text).toContain('skipped source items: 1');
    expect(text).toContain('─── Item 1/2 ───');
    expect(text).toContain('─── Item 2/2 ───');
    expect(text).toContain('─── Collect: reviews ───');
  });

  it('falls back for older sessions without chain metadata', () => {
    const { context } = makeContext();
    const details: SubagentDetails = {
      mode: 'chain',
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [
        singleResult({ agent: 'a', step: 1, status: 'completed', task: 'one' }),
        singleResult({ agent: 'b', step: 2, status: 'completed', task: 'two' }),
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'chain' }], details },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('1. a');
    expect(text).toContain('2. b');
    expect(text).toContain('Chain:');
  });
});

describe('renderResult misc', () => {
  const theme = fakeTheme();

  it('renders empty/unknown results without a status glyph', () => {
    const { context } = makeContext();
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'none' }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );
    expect(text.trim()).toBe('none');
    expect(text).not.toContain(RUNNING_STATUS_GLYPH);
    expect(text).not.toContain('✔');
    expect(text).not.toContain('✗');
  });

  it('uses the static running glyph for background launches', () => {
    const { context } = makeContext();
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
    expect(text).toContain('⧗');
    expect(text).toContain('background');
    expect(text).toContain('agent-bg-1');
    expect(text).toContain('You will be notified when it completes.');
  });

  it('does not invalidate the TUI between host updates', async () => {
    let invalidations = 0;
    const { context } = makeContext({}, () => invalidations++);
    const partial = {
      content: [{ type: 'text', text: 'running' }],
      details: singleDetails(singleResult({ status: 'running', exitCode: -1 })),
    };
    renderResult(partial, { expanded: false, isPartial: true }, theme, context);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(invalidations).toBe(0);
  });
});

function extractParenContent(line: string): string | undefined {
  const m = line.match(/\(([^)]*)\)/);
  return m?.[1];
}

describe('renderResult title', () => {
  const theme = fakeTheme();

  it('shows the title instead of the task preview in single collapse', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      task: 'a long task description here',
      title: '短标题',
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('短标题');
    expect(text).not.toContain('a long task description');
  });

  it('shows the title in single running collapse', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'running',
      exitCode: -1,
      task: 'a long running task description',
      title: '运行中',
      messages: assistantMessages([{ type: 'toolCall', name: 'read', path: 'a.ts' }]),
      usage: { ...emptyUsage(), turns: 1 },
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'run' }], details: singleDetails(r) },
        { expanded: false, isPartial: true },
        theme,
        context
      )
    );
    expect(text).toContain('运行中');
    expect(text).not.toContain('a long running task');
  });

  it('falls back to the task preview when title is blank', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      task: 'a long task description',
      title: '   ',
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('a long task description');
  });

  it('falls back to the task preview when title is missing', () => {
    const { context } = makeContext();
    const r = singleResult({ status: 'completed', task: 'missing title task' });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('missing title task');
  });

  it('clamps a CJK title to at most 30 terminal columns', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      task: 'task',
      title: '一二三四五六七八九十一二三四五六',
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false },
        theme,
        context
      ),
      120
    );
    const firstLine = text.split('\n')[0] ?? '';
    const paren = extractParenContent(firstLine);
    expect(paren).toBeDefined();
    expect(visibleWidth(paren!)).toBeLessThanOrEqual(30);
    expect(paren).toContain('…');
  });

  it('clamps an emoji title to at most 30 terminal columns', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      task: 'task',
      title: '😀😁😂🤣😃😄😅😆😀😁😂🤣',
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: false },
        theme,
        context
      ),
      120
    );
    const firstLine = text.split('\n')[0] ?? '';
    const paren = extractParenContent(firstLine);
    expect(paren).toBeDefined();
    expect(visibleWidth(paren!)).toBeLessThanOrEqual(30);
  });

  it('shows per-task titles in parallel collapse', () => {
    const { context } = makeContext();
    const details = parallelDetails([
      singleResult({ agent: 'a', status: 'completed', task: 'long task one', title: 'one' }),
      singleResult({ agent: 'b', status: 'completed', task: 'long task two', title: 'two' }),
    ]);
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('one');
    expect(text).toContain('two');
    expect(text).not.toContain('long task one');
  });

  it('shows the step title in chain sequential collapse', () => {
    const { context } = makeContext();
    const results = [
      singleResult({
        agent: 'explore',
        step: 1,
        status: 'completed',
        task: 'analyze the codebase',
        title: '分析',
      }),
    ];
    const chain: ChainExecutionDetails = {
      totalSteps: 1,
      steps: [
        {
          kind: 'sequential',
          step: 1,
          agent: 'explore',
          task: 'analyze the codebase',
          title: '分析',
          status: 'completed',
        },
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'chain' }], details: chainDetails(results, chain) },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('分析');
    expect(text).not.toContain('analyze the codebase');
  });

  it('shows the fanout parallel.title in chain collapse', () => {
    const { context } = makeContext();
    const items = [0, 1].map((index) =>
      singleResult({
        agent: 'reviewer',
        status: 'completed',
        step: 1,
        task: `item ${index}`,
        fanout: { index, count: 2, itemTask: `item ${index}` },
      })
    );
    const chain: ChainExecutionDetails = {
      totalSteps: 1,
      steps: [
        {
          kind: 'fanout',
          step: 1,
          agent: 'reviewer',
          taskTemplate: 'review {item}',
          title: '审查',
          status: 'completed',
          collectName: 'reviews',
          executedCount: 2,
          completedCount: 2,
          failedCount: 0,
          runningCount: 0,
          queuedCount: 0,
          skippedCount: 0,
        },
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'chain' }], details: chainDetails(items, chain) },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('审查');
    expect(text).not.toContain('review {item}');
  });

  it('uses the launch title in the background summary', () => {
    const { context } = makeContext();
    const details: SubagentDetails = {
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
          description: 'explore long task',
          startedAt: 0,
          taskPreview: 'long task preview text',
          title: '后台',
        },
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'launched' }], details },
        { expanded: false },
        theme,
        context
      )
    );
    expect(text).toContain('后台');
    expect(text).not.toContain('long task preview text');
  });

  it('falls back to a 30-column task preview for background without title', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const { context } = makeContext();
    const details: SubagentDetails = {
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
          taskPreview: 'find things and more',
        },
      ],
    };
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'launched' }], details },
        { expanded: false },
        theme,
        context
      )
    );
    const labelLine = (text.split('\n')[1] ?? '').trim();
    expect(visibleWidth(labelLine)).toBeLessThanOrEqual(30);
    expect(labelLine).toContain('find');
  });

  it('expanded view shows the full task even with a title', () => {
    const { context } = makeContext();
    const r = singleResult({
      status: 'completed',
      task: 'full task text here',
      title: '短',
    });
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'done' }], details: singleDetails(r) },
        { expanded: true },
        theme,
        context
      )
    );
    expect(text).toContain('─── Task ───');
    expect(text).toContain('full task text here');
  });
});
