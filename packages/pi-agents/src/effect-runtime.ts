// ABOUTME: Leaf Effect runtime bridge — Promise boundary runners and abort helpers.
// ABOUTME: Later phases import these instead of calling Effect.runPromise ad hoc.

import { Cause, Data, Effect, Exit, Option } from 'effect';

/**
 * Typed abort failure for host AbortSignal cancellation.
 * Callers map this to AgentAbortError / interrupt paths; do not treat as domain error or defect.
 */
export class AbortSignalAborted extends Data.TaggedError('AbortSignalAborted')<{
  readonly reason?: unknown;
}> {}

/**
 * Fail immediately when `signal` is already aborted.
 * Does not subscribe for later aborts — compose with interruptible fibers if needed.
 */
export function checkAbortSignal(
  signal: AbortSignal | undefined
): Effect.Effect<void, AbortSignalAborted> {
  if (signal?.aborted) {
    return Effect.fail(new AbortSignalAborted({ reason: signal.reason }));
  }
  return Effect.void;
}

/**
 * Run an Effect as Exit. Typed failures never throw; only runtime defects in the runner itself can.
 */
export function runEffectExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect);
}

/**
 * Run an Effect as a Promise.
 *
 * Rejection wrap rule:
 * - Typed failure that is an `Error` (incl. Data.TaggedError subclasses) → reject with that instance.
 * - Other typed failures → reject with `Error` whose message is the string failure or Cause.pretty.
 * - Defects / interruptions → reject with the defect Error when present, else Cause.pretty Error.
 */
export async function runEffectPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw causeToRejection(exit.cause);
}

function causeToRejection<E>(cause: Cause.Cause<E>): Error {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined) {
    if (failure instanceof Error) {
      return failure;
    }
    if (typeof failure === 'string') {
      return new Error(failure, { cause: failure });
    }
    return new Error(Cause.pretty(cause), { cause: failure as unknown as Error });
  }

  for (const defect of Cause.defects(cause)) {
    if (defect instanceof Error) {
      return defect;
    }
  }

  return new Error(Cause.pretty(cause));
}
