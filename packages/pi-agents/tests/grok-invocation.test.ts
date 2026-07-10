// ABOUTME: Tests for Grok CLI invocation helpers - argument construction and binary resolution.
// ABOUTME: Covers thinking->effort downgrade mapping, system prompt flags, and tool/subagent flags.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../src/agents.ts';
import { buildGrokArgs, getGrokInvocation } from '../src/grok-invocation.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'grok-agent',
    description: 'test grok agent',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/grok-agent.md',
    runtime: 'grok',
    ...overrides,
  };
}

describe('buildGrokArgs', () => {
  it('produces base hardcoded flags and prompt', () => {
    const args = buildGrokArgs(makeAgent(), 'do work');
    expect(args).toEqual([
      '--no-auto-update',
      '--always-approve',
      '--output-format',
      'streaming-json',
      '--no-memory',
      '--no-subagents',
      '-p',
      'Task: do work',
    ]);
  });

  it('includes --model when agent.model is set', () => {
    const args = buildGrokArgs(makeAgent({ model: 'grok-4.5' }), 'go');
    expect(args).toContain('--model');
    const idx = args.indexOf('--model');
    expect(args[idx + 1]).toBe('grok-4.5');
  });

  it('includes --max-turns when agent.maxTurns is set', () => {
    const args = buildGrokArgs(makeAgent({ maxTurns: 5 }), 'go');
    expect(args).toContain('--max-turns');
    const idx = args.indexOf('--max-turns');
    expect(args[idx + 1]).toBe('5');
  });

  describe('thinking -> effort mapping', () => {
    it('omits --effort for off', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'off' }), 'go');
      expect(args).not.toContain('--effort');
    });

    it('maps minimal to low', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'minimal' }), 'go');
      const idx = args.indexOf('--effort');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('low');
    });

    it('maps low to low', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'low' }), 'go');
      expect(args[args.indexOf('--effort') + 1]).toBe('low');
    });

    it('maps medium to medium', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'medium' }), 'go');
      expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    });

    it('maps high to high', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'high' }), 'go');
      expect(args[args.indexOf('--effort') + 1]).toBe('high');
    });

    it('maps xhigh to high', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'xhigh' }), 'go');
      expect(args[args.indexOf('--effort') + 1]).toBe('high');
    });

    it('maps max to high', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'max' }), 'go');
      expect(args[args.indexOf('--effort') + 1]).toBe('high');
    });

    it('omits --effort for unknown thinking values', () => {
      const args = buildGrokArgs(makeAgent({ thinking: 'ultra' }), 'go');
      expect(args).not.toContain('--effort');
    });
  });

  describe('system prompt flags', () => {
    it('uses --rules for append mode (default)', () => {
      const args = buildGrokArgs(
        makeAgent({ systemPrompt: 'You are a test agent.', systemPromptMode: 'append' }),
        'go'
      );
      expect(args).toContain('--rules');
      const idx = args.indexOf('--rules');
      expect(args[idx + 1]).toBe('You are a test agent.');
      expect(args).not.toContain('--system-prompt-override');
    });

    it('uses --system-prompt-override for replace mode', () => {
      const args = buildGrokArgs(
        makeAgent({ systemPrompt: 'Replace everything.', systemPromptMode: 'replace' }),
        'go'
      );
      expect(args).toContain('--system-prompt-override');
      const idx = args.indexOf('--system-prompt-override');
      expect(args[idx + 1]).toBe('Replace everything.');
      expect(args).not.toContain('--rules');
    });

    it('omits system prompt flags when systemPrompt is empty', () => {
      const args = buildGrokArgs(makeAgent({ systemPrompt: '   ' }), 'go');
      expect(args).not.toContain('--rules');
      expect(args).not.toContain('--system-prompt-override');
    });
  });

  describe('tool flags', () => {
    it('includes --tools when agent.tools is set', () => {
      const args = buildGrokArgs(makeAgent({ tools: ['read', 'bash'] }), 'go');
      expect(args).toContain('--tools');
      const idx = args.indexOf('--tools');
      expect(args[idx + 1]).toBe('read,bash');
    });

    it('includes --disallowed-tools when agent.excludeTools is set', () => {
      const args = buildGrokArgs(makeAgent({ excludeTools: ['write', 'edit'] }), 'go');
      expect(args).toContain('--disallowed-tools');
      const idx = args.indexOf('--disallowed-tools');
      expect(args[idx + 1]).toBe('write,edit');
    });

    it('omits tool flags when not set', () => {
      const args = buildGrokArgs(makeAgent(), 'go');
      expect(args).not.toContain('--tools');
      expect(args).not.toContain('--disallowed-tools');
    });
  });

  it('always includes --no-subagents (Grok ignores PI_AGENT_DEPTH)', () => {
    expect(buildGrokArgs(makeAgent(), 'go')).toContain('--no-subagents');
    expect(buildGrokArgs(makeAgent(), 'go', { disableAgentTool: false })).toContain(
      '--no-subagents'
    );
    expect(buildGrokArgs(makeAgent(), 'go', { disableAgentTool: true })).toContain(
      '--no-subagents'
    );
  });

  it('resolvedSkillPaths is accepted but has no effect on args', () => {
    const args = buildGrokArgs(makeAgent(), 'go', {
      resolvedSkillPaths: ['/abs/librarian/SKILL.md'],
    });
    expect(args).not.toContain('--skill');
    expect(args).not.toContain('--no-skills');
  });
});

describe('getGrokInvocation', () => {
  it('returns grok binary with the given args', () => {
    const inv = getGrokInvocation(['--help']);
    expect(inv.command).toBe('grok');
    expect(inv.args).toEqual(['--help']);
  });

  it('does not modify the args array', () => {
    const args = ['--no-auto-update', '-p', 'test'];
    const inv = getGrokInvocation(args);
    expect(inv.args).toBe(args);
  });
});
