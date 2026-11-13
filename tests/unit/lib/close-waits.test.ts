import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloseWaits } from '../../../src/close-waits';

const DRAIN = 60_000;
const GRACE = 300;

/** Tracks whether a promise has settled, without awaiting it. */
const watch = (promise: Promise<unknown>) => {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
};

const never = () => new Promise<void>(() => {});

describe('createCloseWaits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits drainTimeout on a draining close', async () => {
    const waits = createCloseWaits(DRAIN, GRACE);
    const wait = watch(waits.waitOn(never()));

    await vi.advanceTimersByTimeAsync(DRAIN - 1);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.settled).toBe(true);
  });

  it('waits only the grace when the close starts immediate', async () => {
    const waits = createCloseWaits(DRAIN, GRACE);
    waits.escalate();
    const wait = watch(waits.waitOn(never()));

    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.settled).toBe(true);
  });

  it('returns as soon as the promise settles, in either mode', async () => {
    const draining = createCloseWaits(DRAIN, GRACE);
    await draining.waitOn(Promise.resolve());

    const immediate = createCloseWaits(DRAIN, GRACE);
    immediate.escalate();
    await immediate.waitOn(Promise.resolve());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a wait in progress one fresh grace from the escalation', async () => {
    const waits = createCloseWaits(DRAIN, GRACE);
    const wait = watch(waits.waitOn(never()));

    await vi.advanceTimersByTimeAsync(DRAIN / 2);
    expect(wait.settled).toBe(false);
    waits.escalate();

    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(wait.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.settled).toBe(true);
    // Not the rest of drainTimeout: nothing is left pending after the grace.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a promise that settles during the grace end the wait', async () => {
    const waits = createCloseWaits(DRAIN, GRACE);
    const settle = Promise.withResolvers<void>();
    const wait = watch(waits.waitOn(settle.promise));

    waits.escalate();
    await vi.advanceTimersByTimeAsync(GRACE / 2);
    expect(wait.settled).toBe(false);
    settle.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.settled).toBe(true);
  });

  it('escalates once: a second escalation grants no further grace', async () => {
    const waits = createCloseWaits(DRAIN, GRACE);
    const wait = watch(waits.waitOn(never()));

    expect(waits.immediate()).toBe(false);
    expect(waits.escalate()).toBe(true);
    expect(waits.immediate()).toBe(true);

    await vi.advanceTimersByTimeAsync(GRACE / 2);
    expect(waits.escalate()).toBe(false);
    expect(wait.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(GRACE / 2);
    expect(wait.settled).toBe(true);
  });

  it('gives each wait begun after the escalation its own grace', async () => {
    const waits = createCloseWaits(DRAIN, GRACE);
    waits.escalate();
    await vi.advanceTimersByTimeAsync(GRACE * 3);

    const later = watch(waits.waitOn(never()));
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(later.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(later.settled).toBe(true);
  });
});
