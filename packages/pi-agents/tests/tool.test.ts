// ABOUTME: Integration-style tests for executeAgentTool() background dispatch and argument compatibility.
// ABOUTME: Uses an injected fake background manager and a fake workflow runner to avoid spawning real agents.

import { describe, expect, it } from 'bun:test';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { executeAgentTool, type ExecuteAgentToolOptions } from '../src/tool.ts';
import type { BackgroundManager } from '../src/background.ts';
import type { SubagentDetails } from '../src/types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: '/tmp/pi-agents-tool-test',
    mode: 'tui',
    hasUI: false,
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      notify: () => {},
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

function okResult(text: string): AgentResult {
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

function fakeWorkflow(text: string): NonNullable<ExecuteAgentToolOptions['runWorkflow']> {
  return async () => okResult(text);
}

function fakeManager(): {
  manager: BackgroundManager;
  launches: Array<{ description: string; mode: string }>;
  runs: Array<Promise<AgentResult>>;
} {
  const launches: Array<{ description: string; mode: string }> = [];
  const runs: Array<Promise<AgentResult>> = [];
  const manager: BackgroundManager = {
    launch(request) {
      launches.push({ description: request.description, mode: request.mode });
      runs.push(request.run(new AbortController().signal) as Promise<AgentResult>);
      return {
        content: [{ type: 'text', text: `⏳ launched ${request.mode}` }],
        details: {
          mode: 'background',
          agentScope: request.agentScope,
          projectAgentsDir: request.projectAgentsDir,
          builtinAgentsDir: '/builtin',
          results: [],
          background: [
            {
              jobId: 'agent-bg-test',
              mode: request.mode,
              status: 'running',
              agentScope: request.agentScope,
              description: request.description,
              startedAt: 0,
              taskPreview: request.taskPreview,
            },
          ],
        },
      };
    },
    cancelAll() {},
    activeCount: () => launches.length,
    waitForIdle: async () => {
      await Promise.allSettled(runs);
    },
  };
  return { manager, launches, runs };
}

describe('executeAgentTool background dispatch', () => {
  it('runs synchronously when runInBackground is absent', async () => {
    let invoked = 0;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          invoked++;
          return okResult('sync done');
        },
      }
    );
    expect(invoked).toBe(1);
    expect(result.details?.mode).toBe('single');
    expect((result.content[0] as { text: string }).text).toBe('sync done');
  });

  it('launches via the background manager when runInBackground is true', async () => {
    const { manager, launches, runs } = fakeManager();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it later', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].mode).toBe('single');
    expect(result.details?.mode).toBe('background');
    expect((result.content[0] as { text: string }).text).toContain('launched single');
    const inner = await runs[0];
    expect((inner.content[0] as { text: string }).text).toBe('bg done');
  });

  it('strips runInBackground before invoking the workflow runner', async () => {
    const { manager } = fakeManager();
    let observed: { runInBackground?: boolean } | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      {
        backgroundManager: manager,
        runWorkflow: async (params) => {
          observed = params as { runInBackground?: boolean };
          return okResult('done');
        },
      }
    );
    expect(observed?.runInBackground).toBeUndefined();
  });

  it('rejects background execution in json mode', async () => {
    const { manager, launches } = fakeManager();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx({ mode: 'json' } as Partial<ExtensionContext>),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/long-lived/);
    expect(launches.length).toBe(0);
  });

  it('rejects background execution when no manager is provided', async () => {
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { runWorkflow: fakeWorkflow('should not run') }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Background execution/);
  });

  it('reports invalid params when no mode is provided', async () => {
    const result = await executeAgentTool(
      {} as Parameters<typeof executeAgentTool>[0],
      undefined,
      undefined,
      makeCtx()
    );
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid parameters/);
  });

  it('confirms project agents before launching a background job', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-bg-confirm-'));
    const agentsDir = path.join(dir, '.pi', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'myagent.md'),
      '---\nname: myagent\ndescription: confirm me\n---\nbody\n'
    );

    try {
      const { manager, launches } = fakeManager();
      const calls: Array<{ title: string }> = [];
      const ctx = makeCtx({
        cwd: dir,
        hasUI: true,
        ui: {
          confirm: async (title: string) => {
            calls.push({ title });
            return false;
          },
          select: async () => undefined,
          input: async () => undefined,
          notify: () => {},
        },
      } as unknown as Partial<ExtensionContext>);
      const result = await executeAgentTool(
        {
          agent: 'myagent',
          task: 'do it later',
          agentScope: 'project',
          runInBackground: true,
        },
        undefined,
        undefined,
        ctx,
        { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
      );
      expect(calls.length).toBe(1);
      expect(launches.length).toBe(0);
      expect((result.content[0] as { text: string }).text).toMatch(/Canceled/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects oversized parallel tasks before launching a background job', async () => {
    const { manager, launches } = fakeManager();
    const oversized = Array.from({ length: 12 }, (_, i) => ({
      agent: 'noop',
      task: `task ${i}`,
    }));
    const result = await executeAgentTool(
      { tasks: oversized, runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
    );
    expect(launches.length).toBe(0);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Too many parallel tasks/);
  });
});

describe('normalizeAgentArgs', () => {
  it('rewrites snake_case run_in_background to camelCase runInBackground', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
    });
    expect(out).toEqual({ agent: 'noop', task: 'go', runInBackground: true });
  });

  it('does not overwrite an explicit runInBackground value', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
      runInBackground: false,
    });
    expect(out).toEqual({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
      runInBackground: false,
    });
  });

  it('returns the input untouched when run_in_background is missing', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const input = { agent: 'noop', task: 'go' };
    expect(normalizeAgentArgs(input)).toBe(input);
  });
});
