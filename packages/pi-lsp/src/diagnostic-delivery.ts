// ABOUTME: Builds one durable hidden diagnostic message from a registry drain.
// ABOUTME: Used by before_agent_start; does not steer mid-run or invent timestamps.

import type { BeforeAgentStartEventResult } from '@earendil-works/pi-coding-agent';
import * as diagnostics from './diagnostics.ts';

/** customType tag used for hidden diagnostic messages. */
export const DIAGNOSTIC_CUSTOM_TYPE = 'lsp-diagnostics';

export type DiagnosticDeliveryMessage = NonNullable<BeforeAgentStartEventResult['message']>;

/**
 * Drain pending diagnostics for `cwd` into one durable custom message.
 *
 * @returns The message to inject via `before_agent_start`, or `undefined` when
 * there is nothing new to deliver.
 */
export function drainDiagnosticMessage(cwd: string): DiagnosticDeliveryMessage | undefined {
  const block = diagnostics.drain(cwd);
  if (!block) return undefined;

  return {
    customType: DIAGNOSTIC_CUSTOM_TYPE,
    content: block,
    display: false,
    details: { source: 'pi-lsp' },
  };
}
