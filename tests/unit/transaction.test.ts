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
 * how a test makes SQLite leave the transaction by itself. It honours
 * `options.savepoint` the way the real worker does, recording the savepoint
 * statements in `executed`.
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
    query: async function* (
      sql: string,
      _params?: unknown[],
      options?: {
        savepoint?: () =>
          | { conclude?: 'release' | 'undo'; open?: true }
          | undefined;
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

const harness = (
  worker: ReturnType<typeof fakeWorker>,
  overrides: {
    /** Default resolves at once. Override to observe the afterWrite window. */
    afterWrite?: () => Promise<unknown>;
    /** Default never aborts: these tests are about the caller's own signal. */
    closeSignal?: AbortSignal;
  } = {},
) => {
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
    afterWrite: overrides.afterWrite ?? (() => Promise.resolve()),
    onPoisoned: (index: number) => poisoned.push(index),
    closeSignal: overrides.closeSignal ?? new AbortController().signal,
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
      'SAVEPOINT __bsq_sp',
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
          await tx.write('INSERT INTO t VALUES (1)');
        },
        { signal: ctl.signal },
      ),
    ).resolves.toBeUndefined();

    await expect(kept.commit()).resolves.toBeUndefined();
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(worker.executed).toEqual([
      'BEGIN',
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
      first = await tx.write('INSERT INTO t VALUES (1)').catch((e) => e);
      later = await tx.read('SELECT 1').catch((e) => e);
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
    expect(worker.executed).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)']);
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
      const pending = tx.write('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(reason);
      caught = await pending.catch((e) => e);
      gate.resolve();
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(caught).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  it('does not die when a read is abandoned by its own signal (R7)', async () => {
    const worker = fakeWorker([], { 'SELECT slow': never });
    const { transaction } = harness(worker);
    const own = new AbortController();
    await transaction(async (tx) => {
      const pending = tx.read('SELECT slow', [], { signal: own.signal });
      own.abort(new Error('this read only'));
      await pending.catch(() => {});
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(worker.executed).toEqual([
      'BEGIN',
      'SELECT slow',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  // The generator half of the same rules (review I3, T3): settled() and
  // releasing() are two places a statement can end, and each needs its own
  // test — a fake worker exercised only through read()/write() cannot tell
  // them apart.

  // Spec 2026-09-11, R1, the generator half. Falsifiable: in `releasing`, drop
  // the abandon(…) call — the next message then releases the write instead of
  // rolling it back.
  it('rolls back a write issued through tx.chunk() abandoned by its own signal, and goes on', async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1) RETURNING a': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this chunk only');
    let caught: unknown;
    await transaction(async (tx) => {
      const gen = tx.chunk('INSERT INTO t VALUES (1) RETURNING a', [], {
        signal: own.signal,
      });
      const next = gen.next();
      await reached.promise;
      own.abort(reason);
      caught = await next.catch((e) => e);
      gate.resolve();
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(caught).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1) RETURNING a',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
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
    expect(worker.executed).toEqual(['BEGIN', 'SELECT 1']);
  });

  // dieIfConnectionLeft's SUCCESS branch: the statement itself succeeded, so
  // there is no error to keep — the transaction dies with a fresh
  // TRANSACTION_CLOSED naming the method that made SQLite leave.
  it('dies with a TRANSACTION_CLOSED naming read() when the connection reports no transaction after it succeeds', async () => {
    const worker = fakeWorker([], {}, ['SELECT']);
    const { transaction } = harness(worker);

    const outcome = await transaction(async (tx) => {
      await tx.read('SELECT 1');
    }).catch((e) => e);

    expect(outcome).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((outcome as Error).message).toContain('read()');
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
      await tx.write('INSERT INTO t VALUES (1)');
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
      await tx.write('INSERT INTO t VALUES (1)');
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
        await tx.write('INSERT INTO t VALUES (1)');
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
        .write('INSERT INTO t VALUES (1)', [], { signal: ctl.signal })
        .catch((e) => e);
      await tx.write('INSERT INTO t VALUES (2)');
    });

    expect(refused).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
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
      const write = tx.write('INSERT INTO t VALUES (1)', [], {
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
    ['read', (tx) => tx.read('SELECT 2'), 'SELECT 2'],
    [
      'write',
      (tx) => tx.write('INSERT INTO t VALUES (2)'),
      'INSERT INTO t VALUES (2)',
    ],
    ['first', (tx) => tx.first('SELECT 2'), 'SELECT 2'],
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
  ];
  for (const [name, entry, sql] of entries) {
    it(`${name}() concludes the abandoned write's savepoint, with an undo, first`, async () => {
      const executed = await abandonedThen(entry);
      expect(executed.slice(0, 6)).toEqual([
        'BEGIN',
        'SAVEPOINT __bsq_sp',
        'INSERT INTO t VALUES (1)',
        'ROLLBACK TO __bsq_sp',
        'RELEASE __bsq_sp',
        sql,
      ]);
    });
  }

  // Falsifiable: send rollbackNow()'s ROLLBACK through `via(false)` — it then
  // carries the undo, and ROLLBACK TO precedes it.
  it('rollback() concludes nothing: a full ROLLBACK discards every savepoint', async () => {
    const executed = await abandonedThen((tx) => tx.rollback());
    expect(executed).toEqual([
      'BEGIN',
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
      await tx.write('INSERT INTO t VALUES (1)', [], { timeout: 60_000 });
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  // R2. Falsifiable: in `entryWait`, await `abandoned` without racing the
  // waiting statement's signal — the second write then waits for the gate,
  // runs and resolves.
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
      const write = tx.write('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(new Error('the first write only'));
      await write.catch(() => {});
      const waiting = tx.write('INSERT INTO t VALUES (2)', [], {
        signal: second.signal,
      });
      second.abort(reason);
      setTimeout(() => gate.resolve(), 50);
      refused = await waiting.catch((e) => e);
      await tx.write('INSERT INTO t VALUES (3)');
    });
    expect(refused).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (3)',
      'COMMIT',
    ]);
  });

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
        const write = tx.write('INSERT INTO t VALUES (1)', [], {
          signal: own.signal,
        });
        await reached.promise;
        own.abort(new Error('this write only'));
        await write.catch(() => {});
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });
});
