import { describe, expect, it } from '@rstest/core';
import {
  type Abandoned,
  type AbandonState,
  createAbandonRegistry,
  reclaim,
} from '../../src/abandon';

/** A worker and a transport iterator that only record what was asked of them. */
const spies = (state: AbandonState, release?: () => void) => {
  const calls: string[] = [];
  const held: Abandoned = {
    worker: {
      interrupt: () => {
        calls.push('interrupt');
      },
    },
    iterator: {
      return: async () => {
        calls.push('return');
        return { value: undefined, done: true as const };
      },
    },
    state,
    release: () => {
      calls.push('release');
      release?.();
    },
  };
  return { held, calls };
};

describe('reclaim', () => {
  it('does what the lost finally would have done, in the same order', async () => {
    const { held, calls } = spies({ started: true });
    reclaim(held);
    await Promise.resolve();
    expect(calls).toEqual(['interrupt', 'return', 'release']);
  });

  it('does not interrupt a worker whose query never started', async () => {
    const { held, calls } = spies({ started: false });
    reclaim(held);
    await Promise.resolve();
    // return() on an unstarted generator is inert, so it is still called;
    // interrupt() is not, because the worker may be serving someone else.
    expect(calls).toEqual(['return', 'release']);
  });

  it('survives an iterator whose return() rejects', async () => {
    const held: Abandoned = {
      worker: { interrupt: () => {} },
      iterator: { return: async () => Promise.reject(new Error('gone')) },
      state: { started: true },
    };
    expect(() => reclaim(held)).not.toThrow();
    // The rejection must not escape as an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('runs release even when there is no work to interrupt', () => {
    let released = false;
    const { held } = spies({ started: false }, () => {
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
    const { held } = spies({ started: true });
    expect(() => registry.watch(target, held, token)).not.toThrow();
    expect(() => registry.forget(token)).not.toThrow();
    expect(() => registry.forget(token)).not.toThrow();
  });
});
