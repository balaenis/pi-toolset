// ABOUTME: Grok streaming-json NDJSON parser - accumulates text events into a synthetic Message.
// ABOUTME: Maps Grok stopReason values (EndTurn/Cancelled) onto pi conventions (end/max_turns).

import type { Message } from '@earendil-works/pi-ai';
import type { SingleResult } from './types.ts';

interface GrokStreamEvent {
  type?: string;
  data?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
}

function mapGrokStopReason(reason?: string): string | undefined {
  if (reason === 'EndTurn') return 'end';
  if (reason === 'Cancelled') return 'max_turns';
  return reason;
}

export function parseGrokEvent(line: string, result: SingleResult, onUpdate: () => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let event: GrokStreamEvent;
  try {
    event = JSON.parse(trimmed) as GrokStreamEvent;
  } catch {
    return;
  }
  if (!event || typeof event !== 'object') return;

  if (event.type === 'text' && typeof event.data === 'string') {
    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      const textPart = lastMsg.content.find((p) => p.type === 'text');
      if (textPart && textPart.type === 'text') {
        textPart.text += event.data;
      } else {
        lastMsg.content.push({ type: 'text', text: event.data });
      }
    } else {
      result.messages.push({
        role: 'assistant',
        model: result.model ?? '',
        content: [{ type: 'text', text: event.data }],
      } as Message);
    }
    onUpdate();
    return;
  }

  if (event.type === 'end') {
    const mapped = mapGrokStopReason(event.stopReason);
    result.stopReason = mapped;
    result.usage.turns = 1;

    // Message.stopReason is typed as pi-ai StopReason; Grok maps to pi-agent conventions
    // (end/max_turns) stored as loose strings for SingleResult / downstream checks.
    const lastMsg = result.messages[result.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      (lastMsg as { stopReason?: string }).stopReason = mapped;
    } else {
      result.messages.push({
        role: 'assistant',
        model: result.model ?? '',
        content: [],
        stopReason: mapped,
      } as unknown as Message);
    }
    onUpdate();
  }
}
