import { describe, expect, it } from '@rstest/core';
import type { SQLiteTransactionDB } from '../../src/api';
import { SQLiteError } from '../../src/errors';
import { createTransaction } from '../../src/transaction';

/**
 * A worker whose statements can be made to fail by name, and whose statements
 * can be suspended — `hooks` runs before the statement yields, keyed by SQL
 * prefix, which is how a test gets a statement to still be in flight when the
 * signal fires.
 *
 * Like the real worker it reports whether its connection is in a transaction
 * once a statement ends: open after BEGIN, closed after a COMMIT or ROLLBACK
 * that succeeded, and closed after any statement named in `leaveOn` — which is
 * how a test makes SQLite leave the transaction by itself.
 */
const fakeWorker = (
  failOn: string[],
  hooks: Record<string, () => Promise<void> | void> = {},
  leaveOn: string[] = [],
) => {
  const executed: string[] = [];
  const worker = {
    index: 3,
    executed,
    inTransaction: undefined as boolean | undefined,
    query: async function* (sql: string) {
      executed.push(sql);
      const fails = failOn.some((needle) => sql.startsWith(needle));
      try {
        for (const [needle, hook] of Object.entries(hooks))
          if (sql.startsWith(needle)) await hook();
        if (fails) throw new SQLiteError('BUSY', `database is locked (${sql})`);
        yield [] as Record<string, unknown>[];
      } finally {
        if (!fails && sql.startsWith('BEGIN')) worker.inTransaction = true;
        else if (!fails && /^(COMMIT|ROLLBACK)/.test(sql))
          worker.inTransaction = false;
        if (leaveOn.some((needle) => sql.startsWith(needle)))
          worker.inTransaction = false;
      }
    },
    interrupt: () => {},
    quiesce: async () => {},
  };
  return worker;
};

const harness = (worker: ReturnType<typeof fakeWorker>) => {
  const poisoned: number[] = [];
  const warnings: string[] = [];
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
    afterWrite: () => Promise.resolve(),
    onPoisoned: (index: number) => poisoned.push(index),
    // Never aborted here: these tests are about the caller's own signal, and a
    // client that never closes is the state they all assume.
    closeSignal: new AbortController().signal,
    bulkFor: () => ({
      bulkWrite: () => ({ enqueue: async () => {}, close: async () => 0 }),
      output: () => ({ enqueue: async () => {}, close: async () => 0 }),
    }),
    logger: { always: { warn: (message: string) => warnings.push(message) } },
  });
  return { transaction, poisoned, warnings };
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

  // Falsifiable: drop the `worker.inTransaction !== false` condition around the
  // fallback ROLLBACK in src/transaction.ts and a ROLLBACK is sent — which the
  // real SQLite refuses, and refusing it evicts a healthy worker (spec §1.1).
  it('sends no ROLLBACK, and loses no worker, when the connection already left', async () => {
    const worker = fakeWorker(['INSERT'], {}, ['INSERT']);
    const { transaction, poisoned } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(worker.executed).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)']);
    expect(poisoned).toEqual([]);
  });

  it('still rolls back a connection that reports its transaction open', async () => {
    const worker = fakeWorker(['INSERT']);
    const { transaction } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(worker.executed).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
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
    // The breaking change of spec R3: a statement on a transaction that is over
    // reports TRANSACTION_CLOSED, carrying why it is over.
    expect(commitError).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((commitError as Error).cause).toBe(reason);
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

describe('transaction — a closed handle never reaches the worker (spec R3, R4)', () => {
  // Falsifiable, all three: remove the `if (ending)` guard from commit(),
  // rollback() or write() in src/transaction.ts and `executed` grows.
  it('after a commit: commit() resolves, rollback() resolves and warns, a statement is refused', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    let kept!: SQLiteTransactionDB;
    await transaction(async (tx) => {
      kept = tx;
      await tx.write('INSERT INTO t VALUES (1)');
    });
    const executed = [...worker.executed];

    await expect(kept.commit()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    const refused = await kept
      .write('INSERT INTO t VALUES (2)')
      .catch((e) => e);
    expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((refused as Error).cause).toBeUndefined();
    expect(worker.executed).toEqual(executed);
  });

  it('after a rollback: commit() is refused, rollback() resolves silently', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    let kept!: SQLiteTransactionDB;
    await transaction(
      async (tx) => {
        kept = tx;
        await tx.write('INSERT INTO t VALUES (1)');
      },
      { autoCommit: false },
    );
    const executed = [...worker.executed];
    expect(executed.at(-1)).toBe('ROLLBACK');

    const refused = await kept.commit().catch((e) => e);
    expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((refused as Error).cause).toBeUndefined();
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
    expect(worker.executed).toEqual(executed);
  });

  it('after a death: commit() is refused with the cause, rollback() resolves silently', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('abandoned');
    let kept!: SQLiteTransactionDB;
    const entered = deferred();
    const finished = deferred();
    const running = transaction(
      async (tx) => {
        kept = tx;
        entered.resolve();
        await finished.promise;
      },
      { signal: ctl.signal },
    );
    // Abort only once the callback runs: aborting earlier refuses the BEGIN and
    // the callback — and `kept` — never exist.
    await entered.promise;
    ctl.abort(reason);
    await expect(running).rejects.toBe(reason);
    finished.resolve();
    const executed = [...worker.executed];

    const refused = await kept.commit().catch((e) => e);
    expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((refused as Error).cause).toBe(reason);
    await expect(kept.rollback()).resolves.toBeUndefined();
    const statement = await kept.read('SELECT 1').catch((e) => e);
    expect(statement).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((statement as Error).cause).toBe(reason);
    expect(warnings).toEqual([]);
    expect(worker.executed).toEqual(executed);
  });
});
