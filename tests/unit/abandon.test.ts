import { describe, expect, it } from '@rstest/core';
import {
  type Abandoned,
  createAbandonRegistry,
  reclaim,
} from '../../src/abandon';

/** A worker and a transport iterator that only record what was asked of them. */
const spies = (release?: () => void) => {
  const calls: string[] = [];
  const stopped: unknown[] = [];
  const held: Abandoned = {
    worker: {
      interrupt: (on?: object) => {
        calls.push('interrupt');
        stopped.push(on);
      },
    },
    iterator: {
      return: async () => {
        calls.push('return');
        return { value: undefined, done: true as const };
      },
    },
    state: { done: false },
    detach: () => {
      calls.push('detach');
    },
    release: () => {
      calls.push('release');
      release?.();
    },
  };
  return { held, calls, stopped };
};

describe('reclaim', () => {
  it('does what the lost finally would have done, in the same order', async () => {
    const { held, calls } = spies();
    reclaim(held);
    await Promise.resolve();
    expect(calls).toEqual(['detach', 'interrupt', 'return', 'release']);
  });

  it('names the transport it is stopping', () => {
    // The worker cannot know which query asked it to stop, so it is told.
    // Anything else stops whatever the worker has since moved on to, and that
    // consumer sees a short result with no error — the defect this argument
    // exists to prevent. What the naming BUYS is pinned end to end by
    // tests/browser/abandon.test.ts, which needs a real worker.
    const { held, stopped } = spies();
    reclaim(held);
    expect(stopped).toEqual([held.iterator]);
  });

  it('detaches its own listener, and does so before anything else', () => {
    // It may be running FROM that listener, on a signal the caller owns and
    // keeps. Left attached it fires again on the next abort, against whatever
    // the worker is doing then.
    const { held, calls } = spies();
    reclaim(held);
    expect(calls[0]).toBe('detach');
  });

  it('runs once, whichever route reaches it first', async () => {
    const { held, calls } = spies();
    reclaim(held);
    reclaim(held);
    reclaim(held);
    await Promise.resolve();
    expect(calls).toEqual(['detach', 'interrupt', 'return', 'release']);
    expect(held.state.done).toBe(true);
  });

  it('is inert once the generator declared itself finished', async () => {
    // The generator's own `finally` sets `done` before it tears down, so a
    // later collection or abort finds the door closed.
    const { held, calls } = spies();
    held.state.done = true;
    reclaim(held);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it('survives an iterator whose return() rejects', async () => {
    const held: Abandoned = {
      worker: { interrupt: () => {} },
      iterator: { return: async () => Promise.reject(new Error('gone')) },
      state: { done: false },
      detach: () => {},
    };
    expect(() => reclaim(held)).not.toThrow();
    // The rejection must not escape as an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('runs release even when the worker has nothing to interrupt', () => {
    // `release` is the owning layer's resource — a lease, a timer, a merge
    // teardown — and it is owed whatever the worker has moved on to.
    let released = false;
    const { held } = spies(() => {
      released = true;
    });
    reclaim(held);
    expect(released).toBe(true);
  });
});

describe('createAbandonRegistry', () => {
  it('watch and forget delegate to one FinalizationRegistry', () => {
    // Nothing here forces a collection — that is not a schedule a test can
    // assert against. What is pinned is that both calls accept the token and
    // do not throw, which is the contract Task 2 relies on.
    const registry = createAbandonRegistry(() => {});
    const target = {};
    const token = {};
    const { held } = spies();
    expect(() => registry.watch(target, held, token)).not.toThrow();
    expect(() => registry.forget(token)).not.toThrow();
    expect(() => registry.forget(token)).not.toThrow();
  });
});
