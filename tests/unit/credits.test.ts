import { describe, expect, it } from '@rstest/core';
import {
  createCreditGate,
  DEFAULT_CREDIT_WINDOW,
  type Tick,
} from '../../src/credits';

/** A tick that resolves immediately but is still awaited, and counts calls. */
const countingTick = () => {
  let calls = 0;
  const tick: Tick = async () => {
    calls += 1;
  };
  return { tick, calls: () => calls };
};

/** True when `promise` settles before a macrotask boundary. Deterministic in Node. */
const settlesSoon = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
  ]);

describe('createCreditGate', () => {
  it('DEFAULT_CREDIT_WINDOW equals 2', () => {
    expect(DEFAULT_CREDIT_WINDOW).toBe(2);
  });

  it('lets the window through without any grant', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 2);
    expect(await gate.take(1)).toBe('go');
    expect(await gate.take(1)).toBe('go');
  });

  it('blocks once the window is spent, and resumes on a grant', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 1);
    expect(await gate.take(1)).toBe('go');

    const pending = gate.take(1);
    expect(await settlesSoon(pending)).toBe(false);

    gate.grant(1, 1);
    expect(await pending).toBe('go');
  });

  // Falsifiable: drop `wake()` from stop(), or drop `&& !stopped` from the
  // wait condition, and this hangs until the test times out. This is §5.1,
  // the failure that would restart a healthy worker on every first() call.
  it('wakes a wait already in progress when stopped', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 0);
    const pending = gate.take(1);
    gate.stop();
    expect(await pending).toBe('stopped');
  });

  it('returns stopped without waiting once stopped', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 5);
    gate.stop();
    expect(await gate.take(1)).toBe('stopped');
    expect(gate.isStopped()).toBe(true);
  });

  // Falsifiable: remove the callId guard in grant() and this passes a credit
  // from an abandoned query into the current one — §5.4's late arrival.
  it('ignores a grant addressed to another query', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(2, 0);
    gate.grant(1, 5);
    expect(await settlesSoon(gate.take(2))).toBe(false);
  });

  // Falsifiable: make reset() keep the counter and this lets a credit granted
  // for the previous query buy a chunk in the next — §5.4's unspent leftover.
  it('clears unspent credits on reset', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 0);
    gate.grant(1, 5);
    gate.reset(2, 1);
    expect(await gate.take(2)).toBe('go');
    expect(await settlesSoon(gate.take(2))).toBe(false);
  });

  it('treats a take for a superseded query as stopped', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(2, 5);
    expect(await gate.take(1)).toBe('stopped');
  });

  // THE load-bearing test. Falsifiable: skip the tick when credits are
  // available — the obvious "optimisation" — and the count drops below the
  // number of takes. The measurement in spec §2.2 showed that without a task
  // turn per chunk, a mid-query abort is delivered as late as the batch size.
  it('awaits the tick on every take, even when credits are available', async () => {
    const counter = countingTick();
    const gate = createCreditGate(counter.tick);
    gate.reset(1, 3);
    await gate.take(1);
    await gate.take(1);
    await gate.take(1);
    expect(counter.calls()).toBe(3);
  });

  it('signals a row tick every rowsPerTick rows and not before', () => {
    const gate = createCreditGate(countingTick().tick, 3);
    expect(gate.countRow()).toBe(false);
    expect(gate.countRow()).toBe(false);
    expect(gate.countRow()).toBe(true);
    expect(gate.countRow()).toBe(false);
  });

  it('restarts the row count on reset', () => {
    const gate = createCreditGate(countingTick().tick, 3);
    gate.countRow();
    gate.countRow();
    gate.reset(1, 1);
    expect(gate.countRow()).toBe(false);
  });
});
