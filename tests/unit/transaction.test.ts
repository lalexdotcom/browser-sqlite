import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createTransaction } from '../../src/transaction';

/**
 * A worker whose statements can be made to fail by name, and whose statements
 * can be suspended — `hooks` runs before the statement yields, keyed by SQL
 * prefix, which is how a test gets a statement to still be in flight when the
 * signal fires.
 */
const fakeWorker = (
  failOn: string[],
  hooks: Record<string, () => Promise<void> | void> = {},
) => {
  const executed: string[] = [];
  return {
    index: 3,
    executed,
    query: async function* (sql: string) {
      executed.push(sql);
      for (const [needle, hook] of Object.entries(hooks))
        if (sql.startsWith(needle)) await hook();
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
    // Mirrors the real scheduler: the signal aborts the WAIT, rejecting with
    // `signal.reason` while the request is still queued.
    acquire: async (_kind: 'read' | 'write', signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return { worker, release: () => {} };
    },
  };
  const transaction = createTransaction({
    scheduler: scheduler as never,
    afterWrite: () => {},
    onPoisoned: (index: number) => poisoned.push(index),
    bulkFor: () => ({
      bulkWrite: () => ({ enqueue: async () => {}, close: async () => 0 }),
      output: () => ({ enqueue: async () => {}, close: async () => 0 }),
    }),
  });
  return { transaction, poisoned };
};

describe('transaction — a poisoned connection is never re-lent', () => {
  // Falsifiable: delete the onPoisoned call in the catch of the fallback
  // rollback in src/transaction.ts and this goes red. Without it the worker
  // goes back to the pool with an open transaction, where the barrier would
  // refresh nothing and report success.
  it('loses the worker when the fallback ROLLBACK also fails', async () => {
    const worker = fakeWorker(['COMMIT', 'ROLLBACK']);
    const { transaction, poisoned } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(poisoned).toEqual([3]);
  });

  it('does not lose the worker when the rollback succeeds', async () => {
    const worker = fakeWorker(['COMMIT']);
    const { transaction, poisoned } = harness(worker);

    await expect(transaction(async () => {})).rejects.toBeInstanceOf(
      SQLiteError,
    );
    expect(poisoned).toEqual([]);
  });

  it('does not lose a transaction that committed cleanly', async () => {
    const worker = fakeWorker([]);
    const { transaction, poisoned } = harness(worker);

    await transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
    });
    expect(poisoned).toEqual([]);
  });
});

/** A promise plus the handle that settles it, for ordering a test's steps. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const never = () => new Promise<void>(() => {});

describe('transaction — the caller may abandon it', () => {
  it('never opens a transaction when the signal fired before the lease', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('gone before a worker was free');
    ctl.abort(reason);

    await expect(
      transaction(async () => {}, { signal: ctl.signal }),
    ).rejects.toBe(reason);

    expect(worker.executed).toEqual([]);
  });

  // Falsifiable: drop the `begun` flag and this goes red. The catch would send
  // a ROLLBACK to a connection holding no transaction, and the failure of that
  // ROLLBACK would lose a healthy worker.
  it('does not roll back a BEGIN that never opened', async () => {
    const worker = fakeWorker(['BEGIN']);
    const { transaction, poisoned } = harness(worker);

    await expect(transaction(async () => {})).rejects.toBeInstanceOf(
      SQLiteError,
    );

    expect(worker.executed).toEqual(['BEGIN']);
    expect(poisoned).toEqual([]);
  });

  // The window the signal cannot be given to BEGIN itself: a BEGIN that ran on
  // the worker but rejected on the client would leave the transaction open.
  it('rolls back without running the callback when the signal fires during BEGIN', async () => {
    const ctl = new AbortController();
    const reason = new Error('aborted mid-BEGIN');
    const worker = fakeWorker([], { BEGIN: () => ctl.abort(reason) });
    const { transaction, poisoned } = harness(worker);
    let called = false;

    await expect(
      transaction(
        async () => {
          called = true;
        },
        { signal: ctl.signal },
      ),
    ).rejects.toBe(reason);

    expect(called).toBe(false);
    expect(worker.executed).toEqual(['BEGIN', 'ROLLBACK']);
    expect(poisoned).toEqual([]);
  });

  // Falsifiable: stop racing the callback against the signal and this hangs.
  // Without the race an abort landing while the callback sits in user code —
  // an await on anything that is not a statement — is invisible until the
  // callback returns, which may be never.
  it('rejects as soon as the signal fires, without waiting for the callback', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('user code still running');
    const started = deferred();

    const running = transaction(
      async () => {
        started.resolve();
        await never();
      },
      { signal: ctl.signal },
    );

    await started.promise;
    ctl.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(worker.executed).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('does not commit when the callback swallows the abort', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('swallowed by the callback');

    await expect(
      transaction(
        async (tx) => {
          ctl.abort(reason);
          try {
            await tx.write('INSERT INTO t VALUES (1)');
          } catch {
            // The caller decided this statement's failure was survivable. The
            // transaction's own signal says otherwise.
          }
          return 'committed anyway';
        },
        { signal: ctl.signal },
      ),
    ).rejects.toBe(reason);

    expect(worker.executed).toEqual(['BEGIN', 'ROLLBACK']);
  });

  // Falsifiable: remove throwIfAborted() from commit() and the COMMIT reaches
  // the worker — the transaction still rejects, but after the data landed.
  it('refuses an explicit commit() once the signal has fired', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('abandoned, then committed by hand');
    const finished = deferred();
    let commitError: unknown;

    await expect(
      transaction(
        async (tx) => {
          ctl.abort(reason);
          try {
            await tx.commit();
          } catch (error) {
            commitError = error;
          }
          finished.resolve();
        },
        { signal: ctl.signal },
      ),
    ).rejects.toBe(reason);

    await finished.promise;
    expect(commitError).toBe(reason);
    expect(worker.executed).not.toContain('COMMIT');
  });

  // Falsifiable: pass only the statement's own signal down and this hangs —
  // the INSERT is in flight and nothing else can reject it.
  it('aborts a statement that carries a signal of its own', async () => {
    const reached = deferred();
    const worker = fakeWorker([], {
      INSERT: async () => {
        reached.resolve();
        await never();
      },
    });
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const own = new AbortController();
    const reason = new Error('the transaction was abandoned');
    let stmtError: unknown;

    const running = transaction(
      async (tx) => {
        try {
          await tx.write('INSERT INTO t VALUES (1)', [], {
            signal: own.signal,
          });
        } catch (error) {
          stmtError = error;
          throw error;
        }
      },
      { signal: ctl.signal },
    );

    await reached.promise;
    ctl.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(stmtError).toBe(reason);
  });

  it('still honours a statement signal, with its own reason', async () => {
    const reached = deferred();
    const worker = fakeWorker([], {
      INSERT: async () => {
        reached.resolve();
        await never();
      },
    });
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const own = new AbortController();
    const reason = new Error('this statement only');

    const running = transaction(
      async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)', [], { signal: own.signal });
      },
      { signal: ctl.signal },
    );

    await reached.promise;
    own.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });
});
