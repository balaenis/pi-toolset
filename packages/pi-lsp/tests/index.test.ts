// ABOUTME: Lifecycle tests for passive diagnostic delivery via before_agent_start.
// ABOUTME: Asserts batching of latest snapshots and absence of reactive sendMessage.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from '@earendil-works/pi-coding-agent';
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver-types';
import { DIAGNOSTIC_CUSTOM_TYPE } from '../src/diagnostic-delivery.ts';
import { register, resetAll } from '../src/diagnostics.ts';
import extension from '../src/index.ts';

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

function diag(message: string, source?: string, line = 0): LspDiagnostic {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    message,
    severity: 1,
    source,
  };
}

function makeFakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  sendMessageCalls: unknown[];
} {
  const handlers = new Map<string, Handler[]>();
  const sendMessageCalls: unknown[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message: unknown, options?: unknown) {
      sendMessageCalls.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  return { pi, handlers, sendMessageCalls };
}

function makeCtx(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

function makeBeforeAgentStartEvent(): BeforeAgentStartEvent {
  return {
    type: 'before_agent_start',
    prompt: 'hello',
    systemPrompt: 'sys',
    systemPromptOptions: {} as BeforeAgentStartEvent['systemPromptOptions'],
  };
}

beforeEach(() => {
  resetAll();
});

afterEach(() => {
  resetAll();
});

describe('extension diagnostic delivery lifecycle', () => {
  it('registers before_agent_start and does not deliver via context', () => {
    const { pi, handlers } = makeFakePi();
    extension(pi);

    expect(handlers.has('before_agent_start')).toBe(true);
    expect(handlers.has('context')).toBe(false);
    expect(handlers.get('before_agent_start')?.length).toBe(1);
  });

  it('batches latest per-server snapshots into one durable message', async () => {
    const { pi, handlers, sendMessageCalls } = makeFakePi();
    extension(pi);

    const uri = 'file:///tmp/project/src/app.ts';
    register('typescript', uri, [diag('stale TS', 'ts', 0)]);
    register('typescript', uri, [diag('latest TS', 'ts', 1)]);
    register('eslint', uri, [diag('lint issue', 'eslint', 2)]);

    // Registration must never queue a reactive custom message.
    await Promise.resolve();
    expect(sendMessageCalls).toEqual([]);

    const handler = handlers.get('before_agent_start')![0];
    const result = (await handler(
      makeBeforeAgentStartEvent(),
      makeCtx('/tmp/project')
    )) as BeforeAgentStartEventResult | void;

    expect(result).toBeDefined();
    expect(result!.message).toBeDefined();
    expect(result!.message!.customType).toBe(DIAGNOSTIC_CUSTOM_TYPE);
    expect(result!.message!.display).toBe(false);
    expect(result!.message!.details).toEqual({ source: 'pi-lsp' });

    const content = String(result!.message!.content);
    expect(content).toContain('latest TS');
    expect(content).not.toContain('stale TS');
    expect(content).toContain('lint issue');

    // Second lifecycle call with no new diagnostics yields nothing.
    const second = (await handler(
      makeBeforeAgentStartEvent(),
      makeCtx('/tmp/project')
    )) as BeforeAgentStartEventResult | void;
    expect(second).toBeUndefined();
    expect(sendMessageCalls).toEqual([]);
  });

  it('produces zero sendMessage calls after registration and microtask flush', async () => {
    const { pi, sendMessageCalls } = makeFakePi();
    extension(pi);

    register('typescript', 'file:///tmp/a.ts', [diag('e', 'ts', 0)]);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessageCalls).toEqual([]);
  });
});
