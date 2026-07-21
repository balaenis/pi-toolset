// ABOUTME: Unit tests for Effect boundary runners and abort helpers.
// ABOUTME: Covers success, typed failure rejection, Exit capture, and AbortSignal policy.

import { describe, expect, it } from 'bun:test';
import { Data, Effect, Exit } from 'effect';
import {
  AbortSignalAborted,
  checkAbortSignal,
  runEffectExit,
  runEffectPromise,
} from '../src/effect-runtime.ts';

class SampleTaggedFailure extends Data.TaggedError('SampleTaggedFailure')<{
  readonly message: string;
}> {}

describe('runEffectPromise', () => {
  it('resolves the success value', async () => {
    await expect(runEffectPromise(Effect.succeed(42))).resolves.toBe(42);
  });

  it('rejects with the original Error on typed failure', async () => {
    const err = new Error('x');
    await expect(runEffectPromise(Effect.fail(err))).rejects.toBe(err);
  });

  it('rejects with TaggedError instances that extend Error', async () => {
    const err = new SampleTaggedFailure({ message: 'tagged boom' });
    await expect(runEffectPromise(Effect.fail(err))).rejects.toBe(err);
  });

  it('wraps non-Error typed failures in Error', async () => {
    try {
      await runEffectPromise(Effect.fail('string-fail'));
      expect.unreachable('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('string-fail');
    }
  });
});

describe('runEffectExit', () => {
  it('returns success Exit without throwing', async () => {
    const exit = await runEffectExit(Effect.succeed('ok'));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe('ok');
    }
  });

  it('returns failure Exit without throwing', async () => {
    const err = new Error('typed');
    const exit = await runEffectExit(Effect.fail(err));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('checkAbortSignal', () => {
  it('succeeds when signal is undefined', async () => {
    await expect(runEffectPromise(checkAbortSignal(undefined))).resolves.toBeUndefined();
  });

  it('succeeds when signal is not aborted', async () => {
    const controller = new AbortController();
    await expect(runEffectPromise(checkAbortSignal(controller.signal))).resolves.toBeUndefined();
  });

  it('fails with AbortSignalAborted when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('user-cancel');
    try {
      await runEffectPromise(checkAbortSignal(controller.signal));
      expect.unreachable('expected AbortSignalAborted');
    } catch (err) {
      expect(err).toBeInstanceOf(AbortSignalAborted);
      expect((err as AbortSignalAborted)._tag).toBe('AbortSignalAborted');
      expect((err as AbortSignalAborted).reason).toBe('user-cancel');
    }
  });
});
