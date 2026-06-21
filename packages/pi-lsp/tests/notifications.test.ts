// ABOUTME: Unit tests for LSP startup failure notification formatting and deduping.
// ABOUTME: Verifies retry-exhausted messages can surface after earlier startup failures.

import { beforeEach, describe, expect, it } from 'bun:test';
import { maybeNotifyMissingServer, resetMissingServerNotifications } from '../src/notifications.ts';

type NotifyCtx = Parameters<typeof maybeNotifyMissingServer>[1];

function makeCtx(): {
  ctx: NotifyCtx;
  messages: Array<{ message: string; level: string }>;
} {
  const messages: Array<{ message: string; level: string }> = [];
  return {
    messages,
    ctx: {
      hasUI: true,
      ui: {
        notify(message: string, level: string) {
          messages.push({ message, level });
        },
      },
    } as unknown as NotifyCtx,
  };
}

describe('missing server notifications', () => {
  beforeEach(() => {
    resetMissingServerNotifications();
  });

  it('deduplicates repeated failed-start messages with the same failure state', () => {
    const { ctx, messages } = makeCtx();
    const error =
      "LSP server 'typescript' failed to start: connection closed (retrying because unknown)";

    maybeNotifyMissingServer('/tmp/file.ts', ctx, 'edit', 'typescript', error);
    maybeNotifyMissingServer('/tmp/file.ts', ctx, 'edit', 'typescript', error);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain('connection closed');
  });

  it('surfaces retry-exhausted after an earlier retryable startup failure', () => {
    const { ctx, messages } = makeCtx();

    maybeNotifyMissingServer(
      '/tmp/file.ts',
      ctx,
      'edit',
      'typescript',
      "LSP server 'typescript' failed to start: connection closed (retrying because unknown)"
    );
    maybeNotifyMissingServer(
      '/tmp/file.ts',
      ctx,
      'edit',
      'typescript',
      "LSP server 'typescript' startup retry limit exceeded after 3 attempt(s): retrying because unknown"
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]?.message).toContain('startup retry limit exceeded');
  });
});
