import { describe, expect, it } from 'vitest';
import type { Lease } from '../../../src/scheduler';
import { SQLiteError } from '../../../src/types/errors';
import { askVerdict, createVerdictMemo } from '../../../src/verdicts';

/** The client's bounds (`VERDICT_MEMO_ENTRIES`, `VERDICT_MEMO_MAX_LENGTH`). */
const memo = () => createVerdictMemo({ maxEntries: 256, maxLength: 4096 });

describe('verdict memo', () => {
  // Falsifiable: evict by insertion order (drop the re-insertion in get()) —
  // the entry read last goes first.
  it('evicts the least recently used entry past 256', () => {
    const verdicts = memo();
    for (let i = 0; i < 256; i++) verdicts.set(`SELECT ${i}`, 'read');
    expect(verdicts.get('SELECT 0')).toBe('read');
    verdicts.set('SELECT 256', 'write');
    expect(verdicts.size).toBe(256);
    expect(verdicts.get('SELECT 0')).toBe('read');
    expect(verdicts.get('SELECT 1')).toBeUndefined();
    expect(verdicts.get('SELECT 256')).toBe('write');
  });

  // Falsifiable: compare with `>=` in set().
  it('stores a text of 4096 characters and not one of 4097', () => {
    const verdicts = memo();
    const at = `SELECT '${'x'.repeat(4096 - 9)}'`;
    const over = `SELECT '${'x'.repeat(4097 - 9)}'`;
    expect(at.length).toBe(4096);
    expect(over.length).toBe(4097);
    verdicts.set(at, 'read');
    verdicts.set(over, 'read');
    expect(verdicts.get(at)).toBe('read');
    expect(verdicts.get(over)).toBeUndefined();
    expect(verdicts.size).toBe(1);
  });

  // Falsifiable: store only settled verdicts in set().
  it('returns a verdict in flight to every get', () => {
    const verdicts = memo();
    const asking = new Promise<'read'>(() => {});
    verdicts.set('SELECT 1', asking);
    expect(verdicts.get('SELECT 1')).toBe(asking);
    expect(verdicts.get('SELECT 1')).toBe(asking);
  });

  // Falsifiable: make delete() a no-op.
  it('forgets a deleted entry', () => {
    const verdicts = memo();
    verdicts.set('SELECT 1', 'refused');
    verdicts.delete('SELECT 1');
    expect(verdicts.get('SELECT 1')).toBeUndefined();
    expect(verdicts.size).toBe(0);
  });
});

describe('askVerdict', () => {
  /** A worker whose every verdict fails with `error`, counting the asks. */
  const failing = (error: Error) => {
    const worker = {
      asks: 0,
      status: 'READY',
      verdict: async () => {
        worker.asks += 1;
        throw error;
      },
      quiesce: async () => {},
    };
    return worker;
  };
  const deps = (worker: ReturnType<typeof failing>) => ({
    // A task per lease, as the real scheduler gives: an unbounded loop then
    // lets the timer below fire instead of starving it.
    acquire: () =>
      new Promise<{
        worker: typeof worker;
        release: () => void;
        demote: () => void;
      }>((resolve) =>
        setTimeout(resolve, 0, { worker, release: () => {}, demote: () => {} }),
      ),
    applyBarrier: async () => {},
  });

  // Falsifiable: drop the `passes > 1` bound in askVerdict — the asks never end.
  it.each([
    ['BUSY', 5],
    ['BUSY', 6],
    ['STATEMENT_FAILED', 9],
  ] as const)(
    'surfaces a persistent %s (sqliteCode %i) as it is, after exactly two asks',
    async (code, sqliteCode) => {
      const error = new SQLiteError(code, 'transient', { sqliteCode });
      const worker = failing(error);
      const asking = askVerdict(
        'SELECT 1',
        new AbortController().signal,
        deps(worker),
      );
      // Bounded here, so the mutation fails rather than hangs.
      const outcome = await Promise.race([
        asking.then(
          () => 'resolved',
          (e: unknown) => e,
        ),
        new Promise((resolve) => setTimeout(resolve, 200, 'still asking')),
      ]);
      expect(outcome).toBe(error);
      expect(worker.asks).toBe(2);
    },
  );

  // Falsifiable: leave `free` false after a borrowed failed prepare in
  // askVerdict — the re-ask may be lent another transaction's worker.
  it("asks a free worker once a transaction's worker failed the prepare, and surfaces its error after the barrier", async () => {
    const borrowedError = new SQLiteError('STATEMENT_FAILED', 'no such table', {
      sqliteCode: 1,
    });
    const freeError = new SQLiteError('STATEMENT_FAILED', 'no such table', {
      sqliteCode: 1,
    });
    const txWorker = failing(borrowedError);
    const freeWorker = failing(freeError);
    const asked: boolean[] = [];
    const barriers: unknown[] = [];
    const leases = [
      { worker: txWorker, borrowed: true as const },
      { worker: freeWorker },
    ];
    const asking = askVerdict('SELECT * FROM t', new AbortController().signal, {
      acquire: (_signal, free) => {
        asked.push(free);
        const next = leases.shift() ?? { worker: freeWorker };
        const lease: Lease<typeof freeWorker> = {
          ...next,
          release: () => {},
          demote: () => {},
        };
        return new Promise<typeof lease>((resolve) =>
          setTimeout(resolve, 0, lease),
        );
      },
      applyBarrier: async (worker) => {
        barriers.push(worker);
      },
    });
    const outcome = await Promise.race([
      asking.then(
        () => 'resolved',
        (e: unknown) => e,
      ),
      new Promise((resolve) => setTimeout(resolve, 200, 'still asking')),
    ]);
    expect(outcome).toBe(freeError);
    expect(asked).toEqual([false, true]);
    expect(txWorker.asks).toBe(1);
    expect(freeWorker.asks).toBe(2);
    expect(barriers).toEqual([freeWorker]);
  });
});
