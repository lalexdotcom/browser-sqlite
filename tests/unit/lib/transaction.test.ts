import { describe, expect, it, vi } from 'vitest';
import type { SQLiteSavepoint, SQLiteTransactionDB } from '../../../src/api';
import { raceAbort } from '../../../src/queries';
import { createTransaction, exposeTransaction } from '../../../src/transaction';
import { SQLiteError } from '../../../src/types/errors';

/**
 * A worker whose statements can be made to fail by name, and whose statements
 * can be suspended — `hooks` runs before the statement yields, keyed by SQL
 * prefix, which is how a test gets a statement to still be in flight when the
 * signal fires.
 *
 * Like the real worker it reports whether its connection is in a transaction
 * once a statement ends: open after BEGIN, closed after a COMMIT or ROLLBACK
 * that succeeded, and closed after any statement named in `leaveOn` — which is
 * how a test makes SQLite leave the transaction by itself. It honours
 * `options.savepoint` the way the real worker does, recording the savepoint
 * statements in `executed`.
 */
const fakeWorker = (
  failOn: string[],
  hooks: Record<string, () => Promise<void> | void> = {},
  leaveOn: string[] = [],
  /** The rows a statement yields, as one chunk, keyed by its SQL. */
  rowsOf: Record<string, Record<string, unknown>[]> = {},
) => {
  const executed: string[] = [];
  /** The statements sent with `drainWrites`. */
  const drained: string[] = [];
  const flags: {
    sql: string;
    control: boolean;
    uncached: boolean;
    refuseWrite: string | undefined;
  }[] = [];
  const worker = {
    index: 3,
    executed,
    drained,
    flags,
    inTransaction: undefined as boolean | undefined,
    query: async function* (
      sql: string,
      _params?: unknown[],
      options?: {
        savepoint?: () =>
          | { conclude?: 'release' | 'undo'; open?: true }
          | undefined;
        control?: boolean;
        uncached?: boolean;
        refuseWrite?: string;
        drainWrites?: boolean;
      },
    ) {
      // As the real worker (spec 2026-09-11, §4): the conclusion, then the
      // open, then the statement — all recorded, so `executed` is every
      // statement the connection ran.
      const savepoint = options?.savepoint?.();
      if (savepoint?.conclude === 'undo') executed.push('ROLLBACK TO __bsq_sp');
      if (savepoint?.conclude) executed.push('RELEASE __bsq_sp');
      if (savepoint?.open) executed.push('SAVEPOINT __bsq_sp');
      executed.push(sql);
      if (options?.drainWrites) drained.push(sql);
      flags.push({
        sql,
        control: options?.control === true,
        uncached: options?.uncached === true,
        refuseWrite: options?.refuseWrite,
      });
      const fails = failOn.some((needle) => sql.startsWith(needle));
      try {
        for (const [needle, hook] of Object.entries(hooks))
          if (sql.startsWith(needle)) await hook();
        if (fails) throw new SQLiteError('BUSY', `database is locked (${sql})`);
        yield rowsOf[sql] ?? ([] as Record<string, unknown>[]);
      } finally {
        if (!fails && sql.startsWith('BEGIN')) worker.inTransaction = true;
        else if (!fails && /^(COMMIT|ROLLBACK(?!\s+TO\b))/.test(sql))
          worker.inTransaction = false;
        if (leaveOn.some((needle) => sql.startsWith(needle)))
          worker.inTransaction = false;
      }
    },
    interrupt: () => {},
    quiesce: async () => {},
    // Earlier than quiesce() on a real worker: the guard's own condition
    // (src/pool.ts, `free`). Here both are immediate.
    free: async () => {},
  };
  return worker;
};

const harness = (
  worker: ReturnType<typeof fakeWorker>,
  overrides: {
    /** Default resolves at once. Override to observe the afterWrite window. */
    afterWrite?: () => Promise<unknown>;
    /** Default never aborts: these tests are about the caller's own signal. */
    closeSignal?: AbortSignal;
    /** What SQLite says of a statement. Default: a write unless it is a SELECT. */
    kindOf?: (sql: string) => Promise<'read' | 'write'>;
  } = {},
) => {
  const poisoned: number[] = [];
  const warnings: string[] = [];
  /** Every statement the transaction asked SQLite about, in order. */
  const asked: string[] = [];
  const scheduler = {
    // Mirrors the real scheduler: the signal aborts the WAIT, rejecting with
    // `signal.reason` while the request is still queued.
    acquire: async (_kind: 'read' | 'write', signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return { worker, release: () => {} };
    },
  };
  const run = createTransaction({
    scheduler: scheduler as never,
    offer: () => {},
    // As the client's: the signal ends the caller's wait, not the verdict.
    kindOf: (_worker: unknown, sql: string, signal?: AbortSignal) => {
      asked.push(sql);
      const answer =
        overrides.kindOf?.(sql) ??
        Promise.resolve(/^\s*SELECT\b/i.test(sql) ? 'read' : 'write');
      return signal ? raceAbort(signal, answer) : answer;
    },
    afterWrite: overrides.afterWrite ?? (() => Promise.resolve()),
    onPoisoned: (index: number) => poisoned.push(index),
    closeSignal: overrides.closeSignal ?? new AbortController().signal,
    checkStatement: () => {},
    bulkFor: () => ({
      bulkWrite: () => ({ enqueue: async () => {}, close: async () => 0 }),
      output: () => ({ enqueue: async () => {}, close: async () => 0 }),
    }),
    logger: { always: { warn: (message: string) => warnings.push(message) } },
  });
  return { transaction: exposeTransaction(run), poisoned, warnings, asked };
};

// The library's own bulk is handed `writeDirect` as a second argument of the
// runner; the public transaction() passes the callback the object alone.
// Falsifiable: have exposeTransaction in src/transaction.ts pass `run` the
// callback itself, so that it receives the second argument.
describe('transaction — the callback receives the transaction object alone', () => {
  it('is called with one argument', async () => {
    const { transaction } = harness(fakeWorker([]));
    let received: unknown[] = [];
    await transaction(async (...args: unknown[]) => {
      received = args;
    });
    expect(received).toHaveLength(1);
  });
});

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
        await tx.run('INSERT INTO t VALUES (1)');
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
      await tx.run('INSERT INTO t VALUES (1)');
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
        await tx.run('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
    ]);
    expect(poisoned).toEqual([]);
  });

  it('still rolls back a connection that reports its transaction open', async () => {
    const worker = fakeWorker(['INSERT']);
    const { transaction } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
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

    expect(worker.executed).toEqual(['BEGIN IMMEDIATE']);
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
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
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
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
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
            await tx.run('INSERT INTO t VALUES (1)');
          } catch {
            // The caller decided this statement's failure was survivable. The
            // transaction's own signal says otherwise.
          }
          return 'committed anyway';
        },
        { signal: ctl.signal },
      ),
    ).rejects.toBe(reason);

    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
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
          await tx.run('INSERT INTO t VALUES (1)', [], {
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
        await tx.run('INSERT INTO t VALUES (1)', [], { signal: own.signal });
      },
      { signal: ctl.signal },
    );

    await reached.promise;
    own.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });
});

describe('transaction — a closed handle never reaches the worker (spec R3, R4)', () => {
  // Falsifiable, all three: remove the `if (ending)` guard from commit(),
  // rollback() or run() in src/transaction.ts and `executed` grows.
  it('after a commit: commit() resolves, rollback() resolves and warns, a statement is refused', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    let kept!: SQLiteTransactionDB;
    await transaction(async (tx) => {
      kept = tx;
      await tx.run('INSERT INTO t VALUES (1)');
    });
    const executed = [...worker.executed];

    await expect(kept.commit()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    const refused = await kept.run('INSERT INTO t VALUES (2)').catch((e) => e);
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
        await tx.run('INSERT INTO t VALUES (1)');
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
    const statement = await kept.all('SELECT 1').catch((e) => e);
    expect(statement).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((statement as Error).cause).toBe(reason);
    expect(warnings).toEqual([]);
    expect(worker.executed).toEqual(executed);
  });

  // Falsifiable: restore `ending ??= { kind: 'committed' }` in commitNow() and
  // this goes red — a death that lands while the COMMIT is in flight must not
  // out-race a COMMIT that then succeeds.
  it('a death landing during the auto COMMIT still reports committed', async () => {
    const ctl = new AbortController();
    const reason = new Error('late');
    const worker = fakeWorker([], { COMMIT: () => ctl.abort(reason) });
    const { transaction, warnings } = harness(worker);
    let kept!: SQLiteTransactionDB;

    await expect(
      transaction(
        async (tx) => {
          kept = tx;
          await tx.run('INSERT INTO t VALUES (1)');
        },
        { signal: ctl.signal },
      ),
    ).resolves.toBeUndefined();

    await expect(kept.commit()).resolves.toBeUndefined();
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ]);
  });
});

describe('transaction — what else kills it (spec R1)', () => {
  // Falsifiable: remove the dieIfConnectionLeft() call from `settled` in
  // src/transaction.ts; the SELECT runs in what is now autocommit.
  it('dies when the connection reports it left the transaction', async () => {
    const worker = fakeWorker(['INSERT'], {}, ['INSERT']);
    const { transaction, poisoned } = harness(worker);
    let first: unknown;
    let later: unknown;
    const finished = deferred();
    const running = transaction(async (tx) => {
      first = await tx.run('INSERT INTO t VALUES (1)').catch((e) => e);
      later = await tx.all('SELECT 1').catch((e) => e);
      finished.resolve();
    });
    // Captured, not `rejects.toBe(first)`: that would read `first` before the
    // callback has assigned it.
    const outcome = await running.catch((e) => e);
    await finished.promise;
    expect(first).toBeInstanceOf(SQLiteError);
    expect(outcome).toBe(first);
    expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((later as Error).cause).toBe(first);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
    ]);
    expect(poisoned).toEqual([]);
  });

  // Spec 2026-09-11, R1. Falsifiable: in src/transaction.ts's `abandon`, drop
  // `pending = 'undo'` — the next message then releases the abandoned write
  // instead of rolling it back.
  it('rolls back a write abandoned by its own signal, and the transaction goes on', async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this write only');
    let caught: unknown;
    await transaction(async (tx) => {
      const pending = tx.run('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(reason);
      caught = await pending.catch((e) => e);
      gate.resolve();
      await tx.run('INSERT INTO t VALUES (2)');
    });
    expect(caught).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  it('does not die when a read is abandoned by its own signal (R7)', async () => {
    const reached = deferred();
    const worker = fakeWorker([], {
      'SELECT slow': async () => {
        reached.resolve();
        await never();
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    await transaction(async (tx) => {
      const pending = tx.all('SELECT slow', [], { signal: own.signal });
      // After the query is posted: all() may ask a verdict first, and an abort
      // during that wait never reaches the worker, which is not what R7 tests.
      await reached.promise;
      own.abort(new Error('this read only'));
      await pending.catch(() => {});
      await tx.run('INSERT INTO t VALUES (2)');
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SELECT slow',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  // Falsifiable: remove the dieIfConnectionLeft() call from `releasing` in
  // src/transaction.ts; the for-await loop finishes and the transaction
  // commits instead of dying.
  it('dies when the connection leaves the transaction after a tx.chunk() statement', async () => {
    const worker = fakeWorker([], {}, ['SELECT 1']);
    const { transaction } = harness(worker);

    const running = transaction(async (tx) => {
      for await (const _rows of tx.chunk('SELECT 1')) {
        // drain it
      }
    });

    const outcome = await running.catch((e) => e);
    expect(outcome).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'SELECT 1']);
  });

  // dieIfConnectionLeft's SUCCESS branch: the statement itself succeeded, so
  // there is no error to keep — the transaction dies with a fresh
  // TRANSACTION_CLOSED naming the method that made SQLite leave.
  it('dies with a TRANSACTION_CLOSED naming all() when the connection reports no transaction after it succeeds', async () => {
    const worker = fakeWorker([], {}, ['SELECT']);
    const { transaction } = harness(worker);

    const outcome = await transaction(async (tx) => {
      await tx.all('SELECT 1');
    }).catch((e) => e);

    expect(outcome).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((outcome as Error).message).toContain('all()');
  });
});

describe('transaction — closed handle: chunk()/stream() do not wait on the worker (review I2)', () => {
  // Falsifiable: move the `if (ending)` check in `releasing` back inside the
  // try — the finally then awaits worker.quiesce(), which here never
  // resolves, so the bounded race times out instead of rejecting with
  // TRANSACTION_CLOSED.
  it('rejects at once, without awaiting quiesce(), once the transaction has ended', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let kept!: SQLiteTransactionDB;
    await transaction(async (tx) => {
      kept = tx;
      await tx.run('INSERT INTO t VALUES (1)');
    });
    // A worker whose current query never lets go — the reuse guard's
    // unbounded wait this fix must not take.
    worker.quiesce = () => new Promise<void>(() => {});

    const bounded = <T>(promise: Promise<T>, what: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new Error(`timed out waiting on ${what}`)),
            500,
          ),
        ),
      ]);

    const chunkResult = await bounded(
      kept.chunk('SELECT 1').next(),
      'chunk().next()',
    ).catch((e) => e);
    const streamResult = await bounded(
      kept.stream('SELECT 1').next(),
      'stream().next()',
    ).catch((e) => e);

    expect(chunkResult).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect(streamResult).toMatchObject({ code: 'TRANSACTION_CLOSED' });
  });
});

describe('transaction — when chunk() and stream() reach the worker', () => {
  // Falsifiable: in tx.stream(), call start() directly instead of inside the
  // generator — the worker is then asked for the query at the call. In
  // tx.chunk(), defer the call to chunkSource's result — it is not asked until
  // the first next().
  it('asks the worker for a chunk() query at the call, and for a stream() query at its first next()', async () => {
    const worker = fakeWorker([]);
    const query = vi.spyOn(worker, 'query');
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const begun = query.mock.calls.length;
      const chunked = tx.chunk('SELECT 1');
      expect(query.mock.calls.length).toBe(begun + 1);
      const streamed = tx.stream('SELECT 2');
      expect(query.mock.calls.length).toBe(begun + 1);
      await streamed.next();
      expect(query.mock.calls.length).toBe(begun + 2);
      await chunked.return(undefined);
      await streamed.return(undefined);
    });
  });
});

describe('tx.signal — aborts whenever transaction() rejects (spec 2026-09-10, R8 amended)', () => {
  // Falsifiable: remove `die(e)` from the catch in src/transaction.ts — this
  // and the "throws" browser test in tests/browser/tx-handle.test.ts both go
  // red.
  it('aborts with the same error a failing auto-COMMIT rejects with', async () => {
    const worker = fakeWorker(['COMMIT']);
    const { transaction } = harness(worker);
    let seen!: AbortSignal;

    const outcome = await transaction(async (tx) => {
      seen = tx.signal;
      await tx.run('INSERT INTO t VALUES (1)');
    }).catch((e) => e);

    expect(outcome).toBeInstanceOf(SQLiteError);
    expect(seen.aborted).toBe(true);
    expect(seen.reason).toBe(outcome);
  });

  // Falsifiable: move the releaseDeath()/removeEventListener detach in
  // src/transaction.ts's inner finally back to after `await
  // deps.afterWrite(worker)` — this then goes red, since close() would abort
  // tx.signal on a transaction that already resolved as committed.
  it('does not abort tx.signal when close() lands during afterWrite, on a transaction that resolved', async () => {
    const worker = fakeWorker([]);
    const closeCtl = new AbortController();
    const { transaction } = harness(worker, {
      afterWrite: async () => {
        closeCtl.abort(new Error('closed during afterWrite'));
      },
      closeSignal: closeCtl.signal,
    });
    let seen!: AbortSignal;

    await expect(
      transaction(async (tx) => {
        seen = tx.signal;
        await tx.run('INSERT INTO t VALUES (1)');
      }),
    ).resolves.toBeUndefined();

    expect(seen.aborted).toBe(false);
  });
});

describe('transaction — a write whose own signal was already aborted at the call (spec 2026-09-10, D4 reversed)', () => {
  // Falsifiable: remove writeWorker's pre-aborted guard (`if (signal?.aborted)
  // throw signal.reason;`, src/queries.ts) — the write then reaches the fake
  // worker and resolves instead of rejecting with `reason`.
  it('rejects the write alone, and the transaction goes on to COMMIT', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('gone before this write');
    ctl.abort(reason);
    let refused: unknown;

    await transaction(async (tx) => {
      refused = await tx
        .run('INSERT INTO t VALUES (1)', [], { signal: ctl.signal })
        .catch((e) => e);
      await tx.run('INSERT INTO t VALUES (2)');
    });

    expect(refused).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });
});

describe('transaction — a savepointed write, and the message after it (spec 2026-09-11)', () => {
  /** A write abandoned by its own signal, then `entry`: the statements run. */
  const abandonedThen = async (
    entry: (tx: SQLiteTransactionDB) => Promise<unknown>,
  ) => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this write only');
    let caught: unknown;
    await transaction(async (tx) => {
      const write = tx.run('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(reason);
      caught = await write.catch((e) => e);
      gate.resolve();
      await entry(tx);
    });
    expect(caught).toBe(reason);
    return worker.executed;
  };

  // T7. Falsifiable, each: have that one method call its query helper with the
  // raw `worker` instead of `via(…)` — its first message then carries no
  // conclusion, and the abandoned write would be committed.
  const entries: [
    string,
    (tx: SQLiteTransactionDB) => Promise<unknown>,
    string,
  ][] = [
    ['first', (tx) => tx.first('SELECT 2'), 'SELECT 2'],
    [
      'run',
      (tx) => tx.run('INSERT INTO t VALUES (2)'),
      'INSERT INTO t VALUES (2)',
    ],
    ['all', (tx) => tx.all('SELECT 2'), 'SELECT 2'],
    [
      'chunk',
      async (tx) => {
        for await (const _rows of tx.chunk('SELECT 2')) {
          // drain it
        }
      },
      'SELECT 2',
    ],
    [
      'stream',
      async (tx) => {
        for await (const _row of tx.stream('SELECT 2')) {
          // drain it
        }
      },
      'SELECT 2',
    ],
    ['commit', (tx) => tx.commit(), 'COMMIT'],
    ['savepoint', (tx) => tx.savepoint('u'), 'SAVEPOINT "u"'],
  ];
  for (const [name, entry, sql] of entries) {
    it(`${name}() concludes the abandoned write's savepoint, with an undo, first`, async () => {
      const executed = await abandonedThen(entry);
      expect(executed.slice(0, 6)).toEqual([
        'BEGIN IMMEDIATE',
        'SAVEPOINT __bsq_sp',
        'INSERT INTO t VALUES (1)',
        'ROLLBACK TO __bsq_sp',
        'RELEASE __bsq_sp',
        sql,
      ]);
    });
  }

  // T7 for the handle (spec 2026-10-04, U1). Falsifiable, each: run that
  // operation through exec(worker, …) instead of exec(via(false), …).
  for (const [name, end, sql] of [
    ['release', (sp: SQLiteSavepoint) => sp.release(), ['RELEASE "u"']],
    [
      'rollback',
      (sp: SQLiteSavepoint) => sp.rollback(),
      ['ROLLBACK TO "u"', 'RELEASE "u"'],
    ],
  ] as const) {
    it(`a savepoint's ${name}() concludes the abandoned write's savepoint first`, async () => {
      const reached = deferred();
      const gate = deferred();
      const worker = fakeWorker([], {
        'INSERT INTO t VALUES (1)': async () => {
          reached.resolve();
          await gate.promise;
        },
      });
      const { transaction } = harness(worker);
      const own = new AbortController();
      await transaction(async (tx) => {
        const sp = await tx.savepoint('u');
        const write = tx.run('INSERT INTO t VALUES (1)', [], {
          signal: own.signal,
        });
        await reached.promise;
        own.abort(new Error('this write only'));
        await write.catch(() => {});
        gate.resolve();
        await end(sp);
      });
      expect(worker.executed).toEqual([
        'BEGIN IMMEDIATE',
        'SAVEPOINT "u"',
        'SAVEPOINT __bsq_sp',
        'INSERT INTO t VALUES (1)',
        'ROLLBACK TO __bsq_sp',
        'RELEASE __bsq_sp',
        ...sql,
        'COMMIT',
      ]);
    });
  }

  // F3: `entries` above is a hand-written list, so it only catches a seventh
  // method the day someone remembers to add it here too. This pins the list
  // itself against the handle's actual shape: it must name every
  // function-valued member of `tx` except `rollback` (its own test, just
  // below — a full ROLLBACK concludes nothing, so it has no T7 case to
  // share) and `bulkWrite`/`output` (they issue no query of their own; each
  // batch is a `writeDirect()` under the hood, with no verdict, so they run
  // through the very `settled`/`via` this file already exercises via `run`).
  // `writeDirect` itself is not a member of `tx`: the library's own bulk is
  // handed it apart, so no untyped write path is reachable from user code.
  // A new entry point that skips `entries` — and so skips its own T7 case —
  // fails this instead of going unnoticed.
  it('the parameterised list above names every method T7 must cover', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let methodNames: string[] = [];
    await transaction(async (tx) => {
      methodNames = Object.entries(tx)
        .filter(([, value]) => typeof value === 'function')
        .map(([key]) => key);
    });
    const excluded = ['rollback', 'bulkWrite', 'output'];
    expect(methodNames.sort()).toEqual(
      [...entries.map(([entryName]) => entryName), ...excluded].sort(),
    );
  });

  // Falsifiable: send rollbackNow()'s ROLLBACK through `via(false)` — it then
  // carries the undo, and ROLLBACK TO precedes it.
  it('rollback() concludes nothing: a full ROLLBACK discards every savepoint', async () => {
    const executed = await abandonedThen((tx) => tx.rollback());
    expect(executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });

  // Falsifiable: in `via`, set `pending = undefined` when a query opens a
  // savepoint — the savepoint is then never released.
  it('releases a savepointed write that completed, with the next message', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)', [], { timeout: 60_000 });
      await tx.run('INSERT INTO t VALUES (2)');
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  // R2. Falsifiable: in `entryWait`, await `abandoned` without racing the
  // waiting statement's signal. `gate` is deliberately resolved only AFTER
  // `refused` has settled: without the race, `entryWait` can only observe
  // the abandoned write ending once `gate` resolves, and `gate` can only
  // resolve once this test has observed the rejection — a deadlock, which
  // this test's own short timeout turns red promptly instead of hanging.
  it('rejects a statement whose own signal fires while it waits, alone', async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const second = new AbortController();
    const reason = new Error('the second write only');
    let refused: unknown;
    await transaction(async (tx) => {
      const write = tx.run('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(new Error('the first write only'));
      await write.catch(() => {});
      const waiting = tx.run('INSERT INTO t VALUES (2)', [], {
        signal: second.signal,
      });
      second.abort(reason);
      refused = await waiting.catch((e) => e);
      gate.resolve();
      await tx.run('INSERT INTO t VALUES (3)');
    });
    expect(refused).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (3)',
      'COMMIT',
    ]);
  }, 5000);

  // Falsifiable: send the teardown's ROLLBACK through `via(false)` — it then
  // carries the pending undo.
  it('sends the teardown ROLLBACK with no conclusion', async () => {
    const reached = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await never();
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const failure = new Error('give up');
    await expect(
      transaction(async (tx) => {
        const write = tx.run('INSERT INTO t VALUES (1)', [], {
          signal: own.signal,
        });
        await reached.promise;
        own.abort(new Error('this write only'));
        await write.catch(() => {});
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });
});

describe('transaction — BEGIN announces write intent (spec 2026-09-15, A4)', () => {
  // Falsifiable: send 'BEGIN' for every transaction in src/transaction.ts, or
  // 'BEGIN IMMEDIATE' for every one (spec 2026-09-15, A4).
  it('begins a write transaction IMMEDIATE and a read-only one deferred', async () => {
    const writeWorker = fakeWorker([]);
    const { transaction: writeTransaction } = harness(writeWorker);
    await writeTransaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
    });
    expect(writeWorker.executed[0]).toBe('BEGIN IMMEDIATE');

    const readOnlyWorker = fakeWorker([]);
    const { transaction: readOnlyTransaction } = harness(readOnlyWorker);
    await readOnlyTransaction(
      async (tx) => {
        await tx.all('SELECT 1');
      },
      { readOnly: true },
    );
    expect(readOnlyWorker.executed[0]).toBe('BEGIN');
  });
});

describe('transaction — the control flag (spec 2026-10-04, § 4)', () => {
  // Falsifiable: drop `control: true` from exec() in src/transaction.ts.
  it('marks BEGIN and COMMIT as control, and nothing the callback runs', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
    });
    expect(worker.flags).toEqual([
      { sql: 'BEGIN IMMEDIATE', control: true, uncached: false },
      { sql: 'INSERT INTO t VALUES (1)', control: false, uncached: false },
      { sql: 'COMMIT', control: true, uncached: false },
    ]);
  });

  // Falsifiable: send rollbackNow()'s ROLLBACK through a path that skips exec().
  it('marks the teardown ROLLBACK as control', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async () => {
      throw new Error('roll it back');
    }).catch(() => {});
    expect(worker.flags.at(-1)).toEqual({
      sql: 'ROLLBACK',
      control: true,
      uncached: false,
    });
  });
});

describe('transaction — the statement queue advisory', () => {
  /**
   * The advisory lives on a five-second timer, which is why it belongs HERE
   * rather than in the browser suite. A browser test that really waits seven
   * seconds loads the machine, and the cell it shares with `tx-savepoint`
   * measures INTERRUPT LATENCY: T4 failed 2 runs out of 4 with such a test
   * present and 0 of 5 without it (2026-09-22). Fake timers cost nothing and
   * measure the same thing.
   *
   * Falsifiable: raise `QUEUE_WARN_MS` in src/transaction.ts and this goes red.
   */
  it('warns once a statement has waited its turn for several seconds', async () => {
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<void>();
      const worker = fakeWorker([], { 'SELECT slow': () => gate.promise });
      const { transaction, warnings } = harness(worker);

      await transaction(async (tx) => {
        // Issued in one tick: the second waits for the first, which is held.
        const first = tx.all('SELECT slow');
        const queued = tx.all('SELECT 1');

        await vi.advanceTimersByTimeAsync(5_000);
        expect(warnings.some((w) => w.includes('waited several seconds'))).toBe(
          true,
        );
        // It names the remedy, since the only cause it can have is the
        // consumer's.
        expect(warnings.some((w) => w.includes('return()'))).toBe(true);

        gate.resolve();
        await Promise.all([first, queued]);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tx.savepoint() — what reaches the worker (spec 2026-10-04, U2, U6)', () => {
  // Falsifiable: call exec() without `{ uncached: true }` in runControl().
  it('sends each operation as uncached control', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const sp = await tx.savepoint('u');
      await sp.rollback({ release: false });
      await sp.release();
    });
    expect(worker.flags.slice(1, -1)).toEqual([
      { sql: 'SAVEPOINT "u"', control: true, uncached: true },
      { sql: 'ROLLBACK TO "u"', control: true, uncached: true },
      { sql: 'RELEASE "u"', control: true, uncached: true },
    ]);
  });

  it('names unnamed savepoints __bsq_sp_<n>, from 1 in every transaction', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    const names: string[] = [];
    await transaction(async (tx) => {
      names.push((await tx.savepoint()).name, (await tx.savepoint()).name);
    });
    await transaction(async (tx) => {
      names.push((await tx.savepoint()).name);
    });
    expect(names).toEqual(['__bsq_sp_1', '__bsq_sp_2', '__bsq_sp_1']);
    expect(worker.executed).toContain('SAVEPOINT "__bsq_sp_2"');
  });
});

describe('tx.savepoint() — refusals at the call (spec 2026-10-04, E1-E8, U3)', () => {
  it('refuses on a transaction that is over, and so does a handle kept after it (E1)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let kept: SQLiteTransactionDB | undefined;
    let sp: SQLiteSavepoint | undefined;
    await transaction(async (tx) => {
      kept = tx;
      sp = await tx.savepoint('u');
    });
    const sent = worker.executed.length;
    await expect(kept?.savepoint()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
    await expect(sp?.release()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
    await expect(sp?.rollback()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
    expect(worker.executed.length).toBe(sent);
  });

  it('refuses in a read-only transaction (E2)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(
      async (tx) => {
        await expect(tx.savepoint()).rejects.toMatchObject({
          code: 'READ_ONLY_TRANSACTION',
        });
      },
      { readOnly: true },
    );
    expect(worker.executed).toEqual(['BEGIN', 'COMMIT']);
  });

  it('refuses a name already open and sends nothing (E4)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.savepoint('u');
      await expect(tx.savepoint('U')).rejects.toMatchObject({
        code: 'INVALID_IDENTIFIER',
      });
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'COMMIT',
    ]);
  });

  it("refuses a child's rollback after the parent's release, and sends nothing for it (E5, E7)", async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const parent = await tx.savepoint('p');
      const child = await tx.savepoint('c');
      await parent.release();
      await child.release();
      await expect(child.rollback()).rejects.toMatchObject({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'release', savepoint: 'p' },
      });
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "p"',
      'SAVEPOINT "c"',
      'RELEASE "p"',
      'COMMIT',
    ]);
  });

  // Falsifiable: in waitFor() (src/transaction.ts), drop `if (ending) throw closedError(ending);`.
  it('never sends an operation queued behind commit() (E8)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let late: Promise<unknown> | undefined;
    await transaction(
      async (tx) => {
        const commit = tx.commit();
        late = tx.savepoint('late').catch((e) => e);
        await commit;
      },
      { autoCommit: false },
    );
    expect(await late).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  // Falsifiable: make runControl() join the queue after an await instead of synchronously.
  it('opens a savepoint issued without await before the write that follows it', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const sp = tx.savepoint('u');
      const write = tx.run('INSERT INTO t VALUES (1)');
      await Promise.all([sp, write]);
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ]);
  });

  // Falsifiable: in savepoint(), call savepoints.open(name) only after runControl() resolves.
  it('has the stack know a savepoint issued without await at once', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      const first = tx.savepoint('u');
      const second = tx.savepoint('U').catch((e) => e);
      // The refusal settles before the first savepoint's reply arrives.
      const settledFirst = await Promise.race([
        first.then(() => 'first'),
        second.then(() => 'second'),
      ]);
      expect(settledFirst).toBe('second');
      expect(await second).toMatchObject({ code: 'INVALID_IDENTIFIER' });
      await first;
    });
  });
});

describe('tx.savepoint() — failures and endings (spec 2026-10-04, E12, D5, U4, U5)', () => {
  // Falsifiable: drop die(e) from runControl().
  it('kills the transaction when an operation fails, and the teardown concludes nothing (E12)', async () => {
    const worker = fakeWorker(['RELEASE "u"']);
    const { transaction } = harness(worker);
    let caught: unknown;
    const outcome = await transaction(async (tx) => {
      const sp = await tx.savepoint('u');
      caught = await sp.release().catch((e) => e);
      await tx.run('INSERT INTO t VALUES (1)');
    }).catch((e) => e);
    expect(outcome).toBe(caught);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'RELEASE "u"',
      'ROLLBACK',
    ]);
  });

  // Falsifiable: drop die(e) from runControl().
  it('kills the transaction when the RELEASE of a rollback() fails after its ROLLBACK TO succeeded (E12)', async () => {
    const worker = fakeWorker(['RELEASE "u"']);
    const { transaction } = harness(worker);
    let caught: unknown;
    const outcome = await transaction(async (tx) => {
      const sp = await tx.savepoint('u');
      caught = await sp.rollback().catch((e) => e);
      await tx.run('INSERT INTO t VALUES (1)');
    }).catch((e) => e);
    expect(caught).toMatchObject({ code: 'BUSY' });
    expect(outcome).toBe(caught);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'ROLLBACK TO "u"',
      'RELEASE "u"',
      'ROLLBACK',
    ]);
  });

  // Falsifiable: delete the `ending` check between the statements in
  // runControl() — the RELEASE is sent after the transaction has died.
  it('never posts the RELEASE of a rollback() when the transaction died after its ROLLBACK TO', async () => {
    const ctl = new AbortController();
    const reason = new Error('abandoned between the two statements');
    const worker = fakeWorker([], {
      'ROLLBACK TO "u"': () => ctl.abort(reason),
    });
    const { transaction } = harness(worker);
    let caught: unknown;
    await transaction(
      async (tx) => {
        const sp = await tx.savepoint('u');
        caught = await sp.rollback().catch((e) => e);
      },
      { signal: ctl.signal },
    ).catch(() => {});
    expect(caught).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect(worker.executed).not.toContain('RELEASE "u"');
    expect(worker.executed.slice(0, 3)).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "u"',
      'ROLLBACK TO "u"',
    ]);
  });

  it('commits open savepoints with the transaction, without a RELEASE, and closes their handles (D5)', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let sp: SQLiteSavepoint | undefined;
    await transaction(async (tx) => {
      sp = await tx.savepoint('a');
      await tx.savepoint('b');
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "a"',
      'SAVEPOINT "b"',
      'COMMIT',
    ]);
    await expect(sp?.release()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
  });

  it('rolls everything back under autoCommit: false with no commit()', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    let sp: SQLiteSavepoint | undefined;
    await transaction(
      async (tx) => {
        sp = await tx.savepoint('a');
      },
      { autoCommit: false },
    );
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT "a"',
      'ROLLBACK',
    ]);
    await expect(sp?.rollback()).rejects.toMatchObject({
      code: 'TRANSACTION_CLOSED',
    });
  });
});

// Spec: the client's run()/all()/first() are async, so a refused argument
// arrives as the rejection of the returned promise; the transaction's must do
// the same. Falsifiable: drop `async` from tx.run/all/first in
// src/transaction.ts and the call throws instead of returning.
describe('transaction — a refused argument rejects, never throws', () => {
  for (const method of ['first', 'run', 'all'] as const) {
    it(`tx.${method}() rejects a query that is neither a string nor sql`, async () => {
      const { transaction } = harness(fakeWorker([]));
      let returned: Promise<unknown> | undefined;
      await transaction(async (tx) => {
        const call = tx[method] as (query: unknown) => Promise<unknown>;
        const pending = call(42);
        returned = pending;
        await pending.catch(() => {});
      });
      await expect(returned).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    });
  }
});

// As on the client: only first() refuses a write; all(), run(), chunk() and
// stream() take any single statement.
describe('transaction — only first() refuses a write, as the client does', () => {
  const WRITE = 'INSERT INTO t VALUES (1) RETURNING a';

  // Falsifiable: make tx.all() in src/transaction.ts refuse a write; it is
  // then refused before it is sent.
  it('tx.all() takes a write, and sends it', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.all(WRITE);
    });
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', WRITE, 'COMMIT']);
  });

  // The worker decides, from what SQLite reports: tx.first() sends the
  // statement with the code to refuse it by.
  // Falsifiable: drop refuseWrite from tx.first() in src/transaction.ts.
  it('tx.first() leaves the refusal to the worker, with NOT_A_READ_QUERY', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.first(WRITE);
    });
    expect(worker.flags.find((f) => f.sql === WRITE)).toMatchObject({
      refuseWrite: 'NOT_A_READ_QUERY',
    });
  });

  // Falsifiable: drop the readOnly term from via() in src/transaction.ts.
  it('a read-only transaction sends each of its statements with READ_ONLY_TRANSACTION, not its own control', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(
      async (tx) => {
        await tx.all('SELECT 1');
        await tx.run(WRITE).catch(() => {});
      },
      { readOnly: true },
    );
    expect(worker.flags.map((f) => [f.sql, f.refuseWrite])).toEqual([
      ['BEGIN', undefined],
      ['SELECT 1', 'READ_ONLY_TRANSACTION'],
      [WRITE, 'READ_ONLY_TRANSACTION'],
      ['COMMIT', undefined],
    ]);
  });

  // Spec 2026-10-26, § Streaming a write: the generators take a write again,
  // and send every statement with drainWrites.
  // Falsifiable: drop drainWrites from chunkSource in src/transaction.ts.
  for (const method of ['chunk', 'stream'] as const) {
    it(`tx.${method}() takes a write and sends it with drainWrites`, async () => {
      const worker = fakeWorker([]);
      const { transaction } = harness(worker);
      await transaction(async (tx) => {
        const call = tx[method] as (sql: string) => AsyncIterable<unknown>;
        for await (const _ of call(WRITE)) {
          // The fake yields one empty chunk.
        }
      });
      expect(worker.executed).toEqual(['BEGIN IMMEDIATE', WRITE, 'COMMIT']);
      expect(worker.drained).toEqual([WRITE]);
    });
  }
});

describe('transaction — the savepoint asks SQLite (spec 2026-10-26, § Transactions)', () => {
  const ownSignal = () => new AbortController().signal;

  // Falsifiable: drop the `own !== undefined` term from opensSavepoint in
  // src/transaction.ts — every statement then asks.
  it('asks nothing for a statement without its own signal or timeout, or aborted at the call', async () => {
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker);
    const gone = new AbortController();
    gone.abort(new Error('gone'));
    await transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)');
      await tx.all('SELECT 1');
      await tx
        .run('INSERT INTO t VALUES (2)', [], { signal: gone.signal })
        .catch(() => {});
    });
    expect(asked).toEqual([]);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
      'SELECT 1',
      'COMMIT',
    ]);
  });

  // Falsifiable: in `settled`, decide the savepoint before `queueWait` — the
  // verdict is then asked while the statement before it still runs.
  it("asks at the statement's turn, once the statement before it has ended", async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction, asked } = harness(worker);
    let askedMeanwhile: string[] = [];
    await transaction(async (tx) => {
      const first = tx.run('INSERT INTO t VALUES (1)');
      const second = tx.run('INSERT INTO t VALUES (2)', [], {
        signal: ownSignal(),
      });
      await reached.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      askedMeanwhile = [...asked];
      gate.resolve();
      await Promise.all([first, second]);
    });
    expect(askedMeanwhile).toEqual([]);
    expect(asked).toEqual(['INSERT INTO t VALUES (2)']);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'RELEASE __bsq_sp',
      'COMMIT',
    ]);
  });

  // Falsifiable: have opensSavepoint ignore the verdict (`=== 'write'`
  // dropped) — the SELECT then opens a savepoint too.
  it('opens a savepoint for what SQLite calls a write, and none for a read, whatever the text', async () => {
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker);
    await transaction(async (tx) => {
      await tx.run("SELECT 'INSERT'", [], { signal: ownSignal() });
      await tx.run('INSERT INTO t VALUES (1)', [], { signal: ownSignal() });
    });
    expect(asked).toEqual(["SELECT 'INSERT'", 'INSERT INTO t VALUES (1)']);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      "SELECT 'INSERT'",
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'RELEASE __bsq_sp',
      'COMMIT',
    ]);
  });

  // The worker refuses a write before it runs, in a read-only transaction and
  // in first(): there is nothing to undo. Falsifiable, each: drop the readOnly
  // term from opensSavepoint; have first() pass no kind to withSignal.
  it('asks nothing in a read-only transaction', async () => {
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker);
    await transaction(
      async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)', [], { signal: ownSignal() });
      },
      { readOnly: true },
    );
    expect(asked).toEqual([]);
    expect(worker.executed).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ]);
  });

  it('asks nothing for first()', async () => {
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker);
    await transaction(async (tx) => {
      await tx.first('INSERT INTO t VALUES (1)', [], { signal: ownSignal() });
    });
    expect(asked).toEqual([]);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ]);
  });

  // Falsifiable: ask without the statement's signal (`undefined` to
  // deps.kindOf) — the statement then waits for the answer, which comes only
  // after it has settled, and this test times out.
  it('rejects a statement whose own signal fires while SQLite is asked, alone, posting nothing', async () => {
    const answer = deferred();
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker, {
      kindOf: async (sql) => {
        if (sql === 'INSERT INTO t VALUES (1)') await answer.promise;
        return 'write';
      },
    });
    const own = new AbortController();
    const reason = new Error('this write only');
    let refused: unknown;
    await transaction(async (tx) => {
      const pending = tx.run('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      while (asked.length === 0) await Promise.resolve();
      own.abort(reason);
      refused = await pending.catch((e) => e);
      await tx.run('INSERT INTO t VALUES (2)');
      answer.resolve();
    });
    expect(refused).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  }, 5000);

  // Falsifiable: rethrow every failed verdict — the statement then rejects
  // with the verdict's error instead of running and reporting its own.
  it('runs a statement inside the savepoint when its verdict fails', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker, {
      kindOf: async () => {
        throw new SQLiteError('STATEMENT_FAILED', 'database is locked');
      },
    });
    await transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)', [], { signal: ownSignal() });
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'RELEASE __bsq_sp',
      'COMMIT',
    ]);
  });

  // Falsifiable: treat MULTIPLE_STATEMENTS as any failed verdict — the
  // statement then reaches the worker.
  it('rejects MULTIPLE_STATEMENTS from the verdict, posting nothing', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker, {
      kindOf: async () => {
        throw new SQLiteError('MULTIPLE_STATEMENTS', 'two statements');
      },
    });
    let refused: unknown;
    await transaction(async (tx) => {
      refused = await tx
        .run('SELECT 1; SELECT 2', [], { signal: ownSignal() })
        .catch((e) => e);
    });
    expect(refused).toMatchObject({ code: 'MULTIPLE_STATEMENTS' });
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  // Falsifiable: in `releasing`, take the branch from a decision made at the
  // call (savepointed: false) instead of awaiting it at the turn.
  for (const method of ['chunk', 'stream'] as const) {
    it(`tx.${method}() asks at its first next(), and a write verdict runs it savepointed`, async () => {
      const worker = fakeWorker([]);
      const { transaction, asked } = harness(worker, {
        kindOf: async () => 'write',
      });
      let askedAtCall: string[] = [];
      await transaction(async (tx) => {
        const call = tx[method] as (
          sql: string,
          params: unknown[],
          options: { signal: AbortSignal },
        ) => AsyncIterable<unknown>;
        const rows = call('SELECT 1', [], { signal: ownSignal() });
        askedAtCall = [...asked];
        for await (const _ of rows) {
          // drain it
        }
      });
      expect(askedAtCall).toEqual([]);
      expect(asked).toEqual(['SELECT 1']);
      expect(worker.executed).toEqual([
        'BEGIN IMMEDIATE',
        'SAVEPOINT __bsq_sp',
        'SELECT 1',
        'RELEASE __bsq_sp',
        'COMMIT',
      ]);
    });
  }
});

describe('transaction — the savepoint asks SQLite: queue, death, stream (fix round 1)', () => {
  const ownSignal = () => new AbortController().signal;

  // Falsifiable: in `settled`, hand the queue on (`mine.resolve(prior)`)
  // before `decide()` — the next statement then runs during the ask.
  it('runs nothing queued behind a statement until its verdict has come', async () => {
    const answer = deferred();
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker, {
      kindOf: async (sql) => {
        if (sql === 'INSERT INTO t VALUES (1)') await answer.promise;
        return 'write';
      },
    });
    let meanwhile: string[] = [];
    await transaction(async (tx) => {
      const a = tx.run('INSERT INTO t VALUES (1)', [], { signal: ownSignal() });
      const b = tx.run('INSERT INTO t VALUES (2)');
      while (asked.length === 0) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      meanwhile = [...worker.executed];
      answer.resolve();
      await Promise.all([a, b]);
    });
    expect(meanwhile).toEqual(['BEGIN IMMEDIATE']);
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  // Falsifiable: ask with the statement's own signal only (`own.signal` for
  // `options.signal` in `decide`) — the death then does not end the wait, and
  // this test times out on a verdict that never comes.
  it('rejects a statement promptly, posting nothing, when the transaction dies during its ask', async () => {
    const close = new AbortController();
    const reason = new Error('client closed');
    const worker = fakeWorker([]);
    const { transaction, asked } = harness(worker, {
      closeSignal: close.signal,
      kindOf: () => new Promise<'write'>(() => {}),
    });
    let refused: unknown;
    const outcome = await transaction(async (tx) => {
      const pending = tx.run('INSERT INTO t VALUES (1)', [], {
        signal: ownSignal(),
      });
      while (asked.length === 0) await Promise.resolve();
      close.abort(reason);
      refused = await pending.catch((e) => e);
    }).catch((e) => e);
    expect(outcome).toBe(reason);
    expect(refused).toBe(reason);
    expect(worker.executed).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  }, 5000);

  // Falsifiable: in `kindAt`'s catch, clear `pending` — the abandoned write is
  // then released by the next message instead of undone.
  it('leaves a pending undo to the next message when a statement leaves during its ask', async () => {
    const reached = deferred();
    const gate = deferred();
    const answer = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction, asked } = harness(worker, {
      kindOf: async (sql) => {
        if (sql === 'INSERT INTO t VALUES (9)') await answer.promise;
        return 'write';
      },
    });
    const first = new AbortController();
    const second = new AbortController();
    await transaction(async (tx) => {
      const write = tx.run('INSERT INTO t VALUES (1)', [], {
        signal: first.signal,
      });
      await reached.promise;
      first.abort(new Error('the first write only'));
      await write.catch(() => {});
      gate.resolve();
      const waiting = tx.run('INSERT INTO t VALUES (9)', [], {
        signal: second.signal,
      });
      while (!asked.includes('INSERT INTO t VALUES (9)'))
        await new Promise((resolve) => setTimeout(resolve, 0));
      second.abort(new Error('the second write only'));
      await waiting.catch(() => {});
      await tx.run('INSERT INTO t VALUES (2)');
      answer.resolve();
    });
    expect(worker.executed).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  }, 5000);

  // A buffered row on the fast path is already resolved: it wins a race
  // against a microtask queued after the call. Falsifiable: give the adapter
  // `st.own` whatever the decision — the row then comes a turn later.
  it('serves the buffered rows of a stream that is not savepointed on the fast path, own signal or not', async () => {
    const worker = fakeWorker([], {}, [], {
      'SELECT a': [{ a: 1 }, { a: 2 }],
    });
    const { transaction } = harness(worker);
    let winner: unknown;
    await transaction(async (tx) => {
      const rows = tx.stream('SELECT a', [], { signal: ownSignal() });
      expect((await rows.next()).value).toEqual({ a: 1 });
      winner = await Promise.race([
        rows.next().then(() => 'row'),
        Promise.resolve().then(() => 'tick'),
      ]);
      await rows.return(undefined);
    });
    expect(winner).toBe('row');
  });
});
