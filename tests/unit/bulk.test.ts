import { describe, expect, it } from '@rstest/core';
import { createBulk } from '../../src/bulk';
import { SQLiteBulkWriteError } from '../../src/errors';
import { type Locks, noOpLocks } from '../../src/locks';
import { createLogger } from '../../src/logger';

const noopLogger = createLogger('test', false);

/** Records every statement the unit under test emits. */
const recorder = (locks: Locks = noOpLocks) => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 0 };
  };
  const read = async () => [] as any[];
  const transaction = async <T>(callback: (db: any) => Promise<T>) =>
    callback({
      write: async (s: string) => {
        sql.push(s);
        return { result: [], affected: 0 };
      },
      read: async () => [],
    });

  const forTarget = createBulk({ file: 'app.db', locks, logger: noopLogger });

  return {
    sql,
    forTarget,
    /** A target bound to this recorder — what most tests want. */
    target: () => forTarget({ read, write, transaction }),
    deps: { read, write, transaction },
  };
};

describe('bulkWrite quoting (B4)', () => {
  it('quotes the table and every column in the INSERT', async () => {
    const { sql, target } = recorder();
    const { bulkWrite } = target();

    const bulk = bulkWrite('my table', ['a b', 'c']);
    bulk.enqueue({ 'a b': 1, c: 2 });
    await bulk.close();

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('INSERT INTO "my table"');
    expect(sql[0]).toContain('("a b","c")');
  });

  it('neutralises an injection in the table name', async () => {
    const { sql, target } = recorder();
    const { bulkWrite } = target();

    const bulk = bulkWrite('t"; DROP TABLE users; --', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close();

    expect(sql[0]).toContain('INSERT INTO "t""; DROP TABLE users; --"');
    // One statement, not two: the injected text never leaves the quotes.
    expect(sql[0].replace(/"[^"]*(""[^"]*)*"/g, '<ident>')).not.toContain(
      'DROP TABLE',
    );
  });
});

/** Fails the nth write (0-based), records all attempted SQL. */
const failingRecorder = (failAt: number) => {
  const sql: string[] = [];
  let calls = 0;
  const write = async (statement: string) => {
    const call = calls++;
    sql.push(statement);
    if (call === failAt) throw new Error('UNIQUE constraint failed');
    return { result: [] as any[], affected: 1 };
  };
  const read = async () => [] as any[];
  const transaction = async <T>(callback: (db: any) => Promise<T>) =>
    callback({
      write: async (s: string) => {
        sql.push(s);
        return { result: [], affected: 0 };
      },
      read: async () => [],
    });

  const forTarget = createBulk({
    file: 'app.db',
    locks: noOpLocks,
    logger: noopLogger,
  });

  return {
    sql,
    forTarget,
    target: () => forTarget({ read, write, transaction }),
    deps: { read, write, transaction },
  };
};

describe('bulkWrite failure (B5)', () => {
  it('does not attempt later batches once one fails', async () => {
    const { sql, target } = failingRecorder(0);
    const { bulkWrite } = target();

    // keys.length 1 → maxBufferSize is 32766; flush explicitly instead.
    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    const first = bulk.close();
    await expect(first).rejects.toBeInstanceOf(SQLiteBulkWriteError);

    expect(sql).toHaveLength(1);
  });

  it('rejects close() with the original error as cause', async () => {
    const { target } = failingRecorder(0);
    const { bulkWrite } = target();

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });

    const error = await bulk.close().catch((e) => e);
    expect(error).toBeInstanceOf(SQLiteBulkWriteError);
    expect(error.code).toBe('BULK_WRITE_FAILED');
    expect((error.cause as Error).message).toMatch(/UNIQUE/);
  });

  it('throws from enqueue() once the latch is set', async () => {
    const { target } = failingRecorder(0);
    const { bulkWrite } = target();

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close().catch(() => {});

    expect(() => bulk.enqueue({ a: 2 })).toThrow(SQLiteBulkWriteError);
  });

  it('counts rows written and rows not written across batches', async () => {
    // maxVariables 2 with one key → two rows per batch.
    const { sql, deps } = failingRecorder(1);
    const { bulkWrite } = createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
      maxVariables: 2,
    })(deps);

    // Batch 1 (rows 1-2) succeeds, batch 2 (rows 3-4) fails,
    // batch 3 (row 5, flushed by close) is never attempted.
    const bulk = bulkWrite('t', ['a']);
    for (const a of [1, 2, 3, 4, 5]) bulk.enqueue({ a });
    const error = await bulk.close().catch((e) => e);

    expect(error).toBeInstanceOf(SQLiteBulkWriteError);
    expect(error.rowsWritten).toBe(2);
    expect(error.rowsNotWritten).toBe(3);
    expect(sql).toHaveLength(2); // the third batch was never sent
  });

  // Falsifiability pin: deleting `closed = true` from bulkWrite's close() lets
  // a second enqueue() succeed silently, producing a second INSERT statement →
  // sql.toHaveLength(1) turns red.
  it('throws from enqueue() after a successful close()', async () => {
    const { sql, target } = recorder();
    const { bulkWrite } = target();

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close(); // succeeds — closed flag is now set

    expect(() => bulk.enqueue({ a: 2 })).toThrow(SQLiteBulkWriteError);
    expect(() => bulk.enqueue({ a: 2 })).toThrow(/closed/i);
    // No extra INSERT was sent: the enqueue threw before buffering.
    expect(sql).toHaveLength(1);
  });

  // Falsifiability pin: deleting the `if (closed) throw` guard in close() lets
  // the second close() return 0 silently → rejects.toThrow() turns red.
  it('throws from close() after a successful close()', async () => {
    const { target } = recorder();
    const { bulkWrite } = target();

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close(); // succeeds — closed flag is now set

    await expect(bulk.close()).rejects.toThrow(SQLiteBulkWriteError);
    await expect(bulk.close()).rejects.toThrow(/closed/i);
  });
});

describe('the staging sweep', () => {
  /** Locks that are available but always refuse the sweep lock. */
  const refusing = () => {
    let attempts = 0;
    return {
      attempts: () => attempts,
      locks: {
        available: true,
        hold: async () => () => {},
        withLock: async <T>(_name: string, fn: () => Promise<T>) => fn(),
        tryWithLock: async () => {
          attempts += 1;
          return false;
        },
        heldNames: async () => [],
        entries: async () => ({ held: [], pending: [] }),
      },
    };
  };

  // Falsifiable: memoize `swept` only when the sweep actually ran. If the lock
  // was held, another client was doing the work — retrying on every output()
  // would put a lock request in front of every single call.
  it('attempts the sweep once even when the lock is refused', async () => {
    const { attempts, locks } = refusing();
    const { sql, forTarget, deps } = recorder(locks);
    const { output } = forTarget(deps);

    await output('t', { a: 'INTEGER' }).close();
    await output('t', { a: 'INTEGER' }).close();

    expect(attempts()).toBe(1);
    expect(sql.some((s) => s.includes('sqlite_master'))).toBe(false);
  });

  // Falsifiable: move `swept` inside forTarget. Two targets from one client
  // would then each sweep, and a transaction — which builds its own target —
  // would sweep on every single call.
  it('sweeps once across two targets built from one client', async () => {
    let sweeps = 0;
    const locks: Locks = {
      available: true,
      hold: async () => () => {},
      withLock: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      tryWithLock: async (_n, fn) => {
        sweeps += 1;
        await fn();
        return true;
      },
      heldNames: async () => [],
      entries: async () => ({ held: [], pending: [] }),
    };
    const { forTarget, deps } = recorder(locks);

    await forTarget(deps).output('a', { x: 'INTEGER' }).close();
    await forTarget(deps).output('b', { x: 'INTEGER' }).close();

    expect(sweeps).toBe(1);
  });
});

/** Records statements from both plain writes and the swap transaction. */
const outputRecorder = () => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 1 };
  };
  const read = async () => [] as any[];
  const transaction = async <T>(callback: (db: any) => Promise<T>) => {
    sql.push('BEGIN');
    const result = await callback({
      write: async (statement: string) => {
        sql.push(statement);
        return { result: [], affected: 0 };
      },
      read: async (statement: string) => {
        sql.push(statement);
        return [];
      },
    });
    sql.push('COMMIT');
    return result;
  };

  const forTarget = createBulk({
    file: 'app.db',
    locks: noOpLocks,
    logger: noopLogger,
  });

  return {
    sql,
    forTarget,
    target: () => forTarget({ read, write, transaction }),
    deps: { read, write, transaction },
  };
};

describe('output() staging and swap (B5)', () => {
  it('creates a staging table, never the target, before close()', async () => {
    const { sql, target } = outputRecorder();
    const { output } = target();

    const out = output('report', { id: 'INTEGER' });
    out.enqueue({ id: 1 });
    // Let the staging DDL settle without closing.
    await Promise.resolve();
    await Promise.resolve();

    expect(sql.some((s) => s.includes('CREATE TABLE "__bsq_staging_'))).toBe(
      true,
    );
    expect(sql.some((s) => s.includes('DROP TABLE IF EXISTS "report"'))).toBe(
      false,
    );

    await out.close();
  });

  it('drops, renames and indexes inside one transaction, in that order', async () => {
    const { sql, target } = outputRecorder();
    const { output } = target();

    const out = output(
      'report',
      { id: 'INTEGER', label: 'TEXT' },
      { indexes: ['label'] },
    );
    out.enqueue({ id: 1, label: 'a' });
    await out.close();

    const begin = sql.indexOf('BEGIN');
    const drop = sql.findIndex((s) =>
      s.includes('DROP TABLE IF EXISTS "report"'),
    );
    const rename = sql.findIndex((s) => s.includes('RENAME TO "report"'));
    const index = sql.findIndex((s) => s.includes('CREATE INDEX'));
    const commit = sql.indexOf('COMMIT');

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(begin);
    expect(rename).toBeGreaterThan(drop);
    // Indexes are built AFTER the rename, with final names: SQLite has no
    // ALTER INDEX ... RENAME, so indexes built on the staging table would keep
    // __bsq_staging_ names forever.
    expect(index).toBeGreaterThan(rename);
    expect(commit).toBeGreaterThan(index);
    expect(sql[index]).toContain('"report_label_IDX"');
  });

  it('drops the staging table and leaves the target alone when a batch fails', async () => {
    const sql: string[] = [];
    let calls = 0;
    const write = async (statement: string) => {
      sql.push(statement);
      if (statement.startsWith('INSERT')) throw new Error('constraint');
      calls++;
      return { result: [] as any[], affected: 0 };
    };
    const read = async () => [] as any[];
    const transaction = async <T>(cb: (db: any) => Promise<T>) => {
      sql.push('BEGIN');
      return cb({ write: async () => ({ result: [], affected: 0 }) });
    };
    const { output } = createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
    })({ write, read, transaction } as any);

    const out = output('report', { id: 'INTEGER' });
    out.enqueue({ id: 1 });
    await expect(out.close()).rejects.toMatchObject({
      code: 'BULK_WRITE_FAILED',
    });

    expect(
      sql.some((s) => s.includes('DROP TABLE IF EXISTS "__bsq_staging_')),
    ).toBe(true);
    // The target was never touched.
    expect(sql.some((s) => s.includes('"report"'))).toBe(false);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('bulkWrite abort (ABORT-1)', () => {
  /** Lets the chained write promise run before the test looks at it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('rejects close() with the caller’s own reason, not a library error', async () => {
    const { target } = recorder();
    const { bulkWrite } = target();
    const controller = new AbortController();
    const reason = new Error('caller stopped it');

    const bulk = bulkWrite('t', ['a'], { signal: controller.signal });
    bulk.enqueue({ a: 1 });
    controller.abort(reason);

    // Falsifiable: wrap the abort in a SQLiteBulkWriteError and this goes red.
    // Decision A — the abort contract is `rejects with signal.reason`, the same
    // one read/write/first/stream/chunk already honour.
    await expect(bulk.close()).rejects.toBe(reason);
  });

  it('lands between batches, leaving the batches already written in place', async () => {
    // maxVariables 2 with one key → two rows per batch.
    const { sql, deps } = recorder();
    const { bulkWrite } = createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
      maxVariables: 2,
    })(deps);
    const controller = new AbortController();

    const bulk = bulkWrite('t', ['a'], { signal: controller.signal });
    bulk.enqueue({ a: 1 });
    bulk.enqueue({ a: 2 }); // fills the buffer, flushes batch 1
    await settle(); // let batch 1 actually run

    expect(sql).toHaveLength(1);
    controller.abort();

    await expect(bulk.close()).rejects.toMatchObject({ name: 'AbortError' });
    // Falsifiable: drop the pre-write abort check and a second INSERT appears
    // here — issued, then aborted mid-flight, rather than never attempted. The
    // signal does reach the write; this asserts that a batch the abort beat to
    // the start pays no round trip at all.
    expect(sql).toHaveLength(1);
  });

  it('throws the reason from enqueue() once aborted', async () => {
    const { target } = recorder();
    const { bulkWrite } = target();
    const controller = new AbortController();
    const reason = new Error('stop');

    const bulk = bulkWrite('t', ['a'], { signal: controller.signal });
    controller.abort(reason);

    expect(() => bulk.enqueue({ a: 1 })).toThrow(reason);
  });

  it('writes nothing when the signal is already aborted at construction', async () => {
    const { sql, target } = recorder();
    const { bulkWrite } = target();
    const reason = new Error('too late');

    const bulk = bulkWrite('t', ['a'], {
      signal: AbortSignal.abort(reason),
    });

    expect(() => bulk.enqueue({ a: 1 })).toThrow(reason);
    await expect(bulk.close()).rejects.toBe(reason);
    expect(sql).toHaveLength(0);
  });

  it('leaves the target untouched and drops the staging table when output is aborted', async () => {
    const sql: string[] = [];
    const write = async (statement: string) => {
      sql.push(statement);
      return { result: [] as any[], affected: 0 };
    };
    const read = async () => [] as any[];
    const transaction = async <T>(cb: (db: any) => Promise<T>) => {
      sql.push('BEGIN');
      return cb({ write: async () => ({ result: [], affected: 0 }) });
    };
    const { output } = createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
    })({ write, read, transaction } as any);
    const controller = new AbortController();

    const out = output(
      'report',
      { id: 'INTEGER' },
      { signal: controller.signal },
    );
    out.enqueue({ id: 1 });
    controller.abort();

    await expect(out.close()).rejects.toMatchObject({ name: 'AbortError' });

    expect(
      sql.some((s) => s.includes('DROP TABLE IF EXISTS "__bsq_staging_')),
    ).toBe(true);
    // An aborted output() is observationally a no-op: no rename, no partial
    // publication, previous target untouched.
    expect(sql.some((s) => s.includes('"report"'))).toBe(false);
    expect(sql.some((s) => s.startsWith('BEGIN'))).toBe(false);
  });
});

describe('bulkWrite abort with a stalled batch (ABORT-1 regression)', () => {
  /**
   * A write that never settles — what OPFSCoopSyncVFS does on an engine
   * without `readwrite-unsafe`, where one exclusive access handle rotates
   * between workers and a hand-over may never arrive.
   *
   * Falsifiable: drop the signal from the inner write() and this hangs until
   * the test timeout instead of rejecting, which is exactly what the benchmark
   * page did on macOS Safari 27.0.
   */
  it('rejects close() even when a batch is already in flight', async () => {
    const stalled = new Promise<never>(() => {});
    const write = (_sql: string, _params?: any[], options?: any) =>
      Promise.race([
        stalled,
        new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(options.signal.reason),
          );
        }),
      ]) as Promise<{ result: any[]; affected: number }>;
    const read = async () => [] as any[];
    const transaction = async <T>(cb: (db: any) => Promise<T>) =>
      cb({ write: async () => ({ result: [], affected: 0 }) });

    const { bulkWrite } = createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
      maxVariables: 2,
    })({ read, write, transaction } as any);

    const controller = new AbortController();
    const bulk = bulkWrite('t', ['a'], { signal: controller.signal });
    bulk.enqueue({ a: 1 });
    bulk.enqueue({ a: 2 }); // flushes; the batch stalls inside write()

    const closing = bulk.close();
    await new Promise((r) => setTimeout(r, 0)); // let the batch reach write()
    controller.abort();

    await expect(
      Promise.race([
        closing,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('close() never settled')), 1000),
        ),
      ]),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/**
 * A recorder whose writes settle only when the test says so — the only way to
 * observe a queue that is full, since a write that resolves immediately empties
 * it before the next enqueue can see it.
 */
const gatedRecorder = () => {
  const sql: string[] = [];
  const gates: (() => void)[] = [];
  const write = (statement: string) => {
    sql.push(statement);
    return new Promise<{ result: any[]; affected: number }>((resolve) => {
      gates.push(() => resolve({ result: [], affected: 1 }));
    });
  };
  const read = async () => [] as any[];
  const transaction = async <T>(cb: (db: any) => Promise<T>) =>
    cb({
      write: async () => ({ result: [], affected: 0 }),
      read: async () => [],
    });

  return {
    sql,
    /** Settles the oldest write still in flight. */
    settleOne: () => gates.shift()?.(),
    settleAll: () => {
      while (gates.length) gates.shift()?.();
    },
    deps: { read, write, transaction } as any,
  };
};

/** Tracks whether a promise has settled, without awaiting it. */
const watch = (promise: Promise<unknown>) => {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
};

/** Lets every queued microtask run. */
const ticks = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe('bulkWrite back-pressure', () => {
  // maxVariables 2 with one key → 2 rows per batch, so the derived default
  // queueSize is 4 rows.
  const bulkFactory = (maxVariables: number, deps: any) =>
    createBulk({
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
      maxVariables,
    })(deps);

  // Falsifiable, verified: delete `if (queuedRows < queueSize) return ADMITTED;`
  // from enqueue() and this goes red — every call would return the deferred, and
  // the gated batch never settles.
  it('resolves without deferring while the queue is under the cap', async () => {
    const { deps } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a']);

    const first = watch(bulk.enqueue({ a: 1 }));
    const second = watch(bulk.enqueue({ a: 2 })); // flushes 2 rows, cap is 4
    await ticks();

    expect(first()).toBe(true);
    expect(second()).toBe(true);
  });

  // Falsifiable: return the shared resolved promise unconditionally and this
  // goes red — the fourth enqueue would settle with nothing written.
  it('defers once the queue is full, and resolves when a batch settles', async () => {
    const { deps, settleOne } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a']);

    bulk.enqueue({ a: 1 });
    bulk.enqueue({ a: 2 }); // queued: 2
    bulk.enqueue({ a: 3 });
    const fourth = watch(bulk.enqueue({ a: 4 })); // queued: 4, at the cap
    await ticks();
    expect(fourth()).toBe(false);

    settleOne(); // queued falls back to 2
    await ticks();
    expect(fourth()).toBe(true);
  });

  // Falsifiable: hard-code the default and this goes red — both writers would
  // defer at the same row count regardless of their width.
  it('derives the default cap from the column count', async () => {
    const narrow = gatedRecorder();
    const wide = gatedRecorder();
    // maxVariables 4: one column → 4 rows per batch, cap 8;
    // two columns → 2 rows per batch, cap 4.
    const one = bulkFactory(4, narrow.deps).bulkWrite('t', ['a']);
    const two = bulkFactory(4, wide.deps).bulkWrite('t', ['a', 'b']);

    let lastNarrow!: () => boolean;
    let lastWide!: () => boolean;
    for (let i = 0; i < 4; i++) {
      lastNarrow = watch(one.enqueue({ a: i }));
      lastWide = watch(two.enqueue({ a: i, b: i }));
    }
    await ticks();

    // Four rows: the wide writer has flushed two batches and reached its cap;
    // the narrow one has flushed one batch and is at half of its own.
    expect(lastWide()).toBe(false);
    expect(lastNarrow()).toBe(true);
  });

  // Falsifiable, verified: drop `options?.queueSize ??` from the queueSize
  // initialiser and this goes red — the explicit 1 is silently replaced by the
  // derived default of 4, which two queued rows do not reach.
  it('honours an explicit cap smaller than a single batch', async () => {
    const { deps } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a'], { queueSize: 1 });

    const first = watch(bulk.enqueue({ a: 1 })); // buffered, nothing queued
    const second = watch(bulk.enqueue({ a: 2 })); // flushes 2 rows ≥ 1
    await ticks();

    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });

  // Falsifiable: reject the returned promise on failure and this goes red.
  // A promise the caller is allowed to ignore must never reject — that is one
  // unhandledrejection per failed load.
  it('resolves rather than rejecting when a batch fails', async () => {
    const { deps } = failingRecorder(0);
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a'], { queueSize: 1 });

    bulk.enqueue({ a: 1 });
    await expect(bulk.enqueue({ a: 2 })).resolves.toBeUndefined();

    // The failure still surfaces where it always did.
    expect(() => bulk.enqueue({ a: 3 })).toThrow(SQLiteBulkWriteError);
    await expect(bulk.close()).rejects.toBeInstanceOf(SQLiteBulkWriteError);
  });

  // Falsifiable, verified: drop the abort listener that releases the waiter and
  // this fails at the release assertion — `watch()` polls a flag, so the test
  // reports rather than hanging. What would hang is the real producer: parked on
  // a pool that never frees a worker, it could not be abandoned, which is the
  // hole ABORT-1 paid for three times.
  it('releases a waiting enqueue() when the signal fires', async () => {
    const { deps } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const controller = new AbortController();
    const reason = new Error('load abandoned');
    const bulk = bulkWrite('t', ['a'], {
      queueSize: 1,
      signal: controller.signal,
    });

    bulk.enqueue({ a: 1 });
    const waiting = watch(bulk.enqueue({ a: 2 })); // flushes, never settles
    await ticks();
    expect(waiting()).toBe(false);

    controller.abort(reason);
    await ticks();
    expect(waiting()).toBe(true);

    expect(() => bulk.enqueue({ a: 3 })).toThrow(reason);
  });

  // Falsifiable, verified: drop `queueSize` from the bulkWrite() call inside
  // output() and this is the ONLY test that goes red. One forwarded field, one
  // pin — it is the kind of line a refactor loses in silence.
  // Falsifiable, verified: drop the `Math.max(1, …)` around queueSize and this
  // fails at the last assertion — with a cap of 0 the release condition
  // `queuedRows < queueSize` is never true, so the producer is parked for ever.
  it('treats a cap below one as one', async () => {
    const { deps, settleOne } = gatedRecorder();
    const { bulkWrite } = bulkFactory(2, deps);
    const bulk = bulkWrite('t', ['a'], { queueSize: 0 });

    bulk.enqueue({ a: 1 });
    const second = watch(bulk.enqueue({ a: 2 })); // flushes 2 rows
    await ticks();
    expect(second()).toBe(false);

    settleOne();
    await ticks();
    expect(second()).toBe(true);
  });

  it('applies the cap to output() as well', async () => {
    const { deps } = gatedRecorder();
    const { output } = bulkFactory(2, deps);
    const out = output('products', { a: 'INTEGER' }, { queueSize: 1 });

    const first = watch(out.enqueue({ a: 1 }));
    const second = watch(out.enqueue({ a: 2 }));
    await ticks();

    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });
});
