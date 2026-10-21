import { describe, expect, it, vi } from 'vitest';
import { trackIdbTransactions } from '../../../src/worker/idb-transactions';

/** An IndexedDB transaction as far as the tracker sees one: its events. */
class FakeTransaction extends EventTarget {
  complete() {
    this.dispatchEvent(new Event('complete'));
  }
  abort() {
    this.dispatchEvent(new Event('abort'));
  }
  error() {
    this.dispatchEvent(new Event('error'));
  }
}

/** A fresh prototype per test: the tracker replaces its `transaction`. */
const fakeDatabase = () => {
  class FakeDatabase {
    transaction(): FakeTransaction {
      return new FakeTransaction();
    }
  }
  const tracker = trackIdbTransactions(
    FakeDatabase.prototype as unknown as IDBDatabase,
  );
  const db = new FakeDatabase();
  return { tracker, begin: () => db.transaction() };
};

/** Whether `promise` has settled once pending callbacks have run. */
const isSettled = async (promise: Promise<unknown>) => {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 0));
  return settled;
};

describe('trackIdbTransactions', () => {
  it('settles at once when no transaction is live', async () => {
    const { tracker } = fakeDatabase();
    expect(await isSettled(tracker.settled(1000))).toBe(true);
  });

  // Falsifiable: settle on the request's success instead — Safari 26 then
  // keeps the connection of the worker terminated right after.
  it('waits for a live transaction to complete', async () => {
    const { tracker, begin } = fakeDatabase();
    const tx = begin();
    const settled = tracker.settled(1000);
    expect(await isSettled(settled)).toBe(false);
    tx.complete();
    expect(await isSettled(settled)).toBe(true);
  });

  it('counts an aborted transaction as settled', async () => {
    const { tracker, begin } = fakeDatabase();
    const tx = begin();
    const settled = tracker.settled(1000);
    tx.abort();
    expect(await isSettled(settled)).toBe(true);
  });

  // A request's error bubbles to its transaction, which goes on unless it aborts.
  it('does not count an error event as the end of a transaction', async () => {
    const { tracker, begin } = fakeDatabase();
    const tx = begin();
    const settled = tracker.settled(1000);
    tx.error();
    expect(await isSettled(settled)).toBe(false);
    tx.complete();
    expect(await isSettled(settled)).toBe(true);
  });

  it('waits for a transaction started while it waits', async () => {
    const { tracker, begin } = fakeDatabase();
    const first = begin();
    const settled = tracker.settled(1000);
    const second = begin();
    first.complete();
    expect(await isSettled(settled)).toBe(false);
    second.complete();
    expect(await isSettled(settled)).toBe(true);
  });

  it('gives up at its bound', async () => {
    vi.useFakeTimers();
    try {
      const { tracker, begin } = fakeDatabase();
      begin();
      const settled = tracker.settled(500);
      await vi.advanceTimersByTimeAsync(499);
      expect(await Promise.race([settled.then(() => true), false])).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('refuseNew', () => {
    it('makes every later transaction throw InvalidStateError', () => {
      const { tracker, begin } = fakeDatabase();
      tracker.refuseNew();
      expect(begin).toThrow(
        expect.objectContaining({ name: 'InvalidStateError' }),
      );
    });

    it('still waits for the transactions already live', async () => {
      const { tracker, begin } = fakeDatabase();
      const tx = begin();
      tracker.refuseNew();
      const settled = tracker.settled(1000);
      expect(await isSettled(settled)).toBe(false);
      tx.complete();
      expect(await isSettled(settled)).toBe(true);
    });
  });
});
