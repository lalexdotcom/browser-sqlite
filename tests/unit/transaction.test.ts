import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createTransaction } from '../../src/transaction';

/** A worker whose statements can be made to fail by name. */
const fakeWorker = (failOn: string[]) => {
  const executed: string[] = [];
  return {
    index: 3,
    executed,
    query: async function* (sql: string) {
      executed.push(sql);
      if (failOn.some((needle) => sql.startsWith(needle)))
        throw new SQLiteError('BUSY', `database is locked (${sql})`);
      yield [] as Record<string, unknown>[];
    },
    interrupt: () => {},
    quiesce: async () => {},
  };
};

const harness = (worker: ReturnType<typeof fakeWorker>) => {
  const poisoned: number[] = [];
  const scheduler = {
    acquire: async () => ({ worker, release: () => {} }),
  };
  const transaction = createTransaction({
    scheduler: scheduler as never,
    afterWrite: () => {},
    onPoisoned: (index: number) => poisoned.push(index),
  });
  return { transaction, poisoned };
};

describe('transaction — a poisoned connection is never re-lent', () => {
  // Falsifiable: delete the onPoisoned call in the catch of the fallback
  // rollback in src/transaction.ts and this goes red. Without it the worker
  // goes back to the pool with an open transaction, where the barrier would
  // refresh nothing and report success.
  it('evicts the worker when the fallback ROLLBACK also fails', async () => {
    const worker = fakeWorker(['COMMIT', 'ROLLBACK']);
    const { transaction, poisoned } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(poisoned).toEqual([3]);
  });

  it('does not evict when the rollback succeeds', async () => {
    const worker = fakeWorker(['COMMIT']);
    const { transaction, poisoned } = harness(worker);

    await expect(transaction(async () => {})).rejects.toBeInstanceOf(
      SQLiteError,
    );
    expect(poisoned).toEqual([]);
  });

  it('does not evict a transaction that committed cleanly', async () => {
    const worker = fakeWorker([]);
    const { transaction, poisoned } = harness(worker);

    await transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
    });
    expect(poisoned).toEqual([]);
  });
});
