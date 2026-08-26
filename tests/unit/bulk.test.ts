import { describe, expect, it } from '@rstest/core';
import { createBulk } from '../../src/bulk';
import { SQLiteBulkWriteError } from '../../src/errors';
import { noOpLocks } from '../../src/locks';
import { createLogger } from '../../src/logger';

const noopLogger = createLogger('test', false);

/** Records every statement the unit under test emits. */
const recorder = () => {
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
  return {
    sql,
    deps: {
      write,
      read,
      transaction,
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
    },
  };
};

describe('bulkWrite quoting (B4)', () => {
  it('quotes the table and every column in the INSERT', async () => {
    const { sql, deps } = recorder();
    const { bulkWrite } = createBulk(deps);

    const bulk = bulkWrite('my table', ['a b', 'c']);
    bulk.enqueue({ 'a b': 1, c: 2 });
    await bulk.close();

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('INSERT INTO "my table"');
    expect(sql[0]).toContain('("a b","c")');
  });

  it('neutralises an injection in the table name', async () => {
    const { sql, deps } = recorder();
    const { bulkWrite } = createBulk(deps);

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
  return {
    sql,
    deps: {
      write,
      read,
      transaction,
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
    },
  };
};

describe('bulkWrite failure (B5)', () => {
  it('does not attempt later batches once one fails', async () => {
    const { sql, deps } = failingRecorder(0);
    const { bulkWrite } = createBulk(deps);

    // keys.length 1 → maxBufferSize is 32766; flush explicitly instead.
    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    const first = bulk.close();
    await expect(first).rejects.toBeInstanceOf(SQLiteBulkWriteError);

    expect(sql).toHaveLength(1);
  });

  it('rejects close() with the original error as cause', async () => {
    const { deps } = failingRecorder(0);
    const { bulkWrite } = createBulk(deps);

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });

    const error = await bulk.close().catch((e) => e);
    expect(error).toBeInstanceOf(SQLiteBulkWriteError);
    expect(error.code).toBe('BULK_WRITE_FAILED');
    expect((error.cause as Error).message).toMatch(/UNIQUE/);
  });

  it('throws from enqueue() once the latch is set', async () => {
    const { deps } = failingRecorder(0);
    const { bulkWrite } = createBulk(deps);

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close().catch(() => {});

    expect(() => bulk.enqueue({ a: 2 })).toThrow(SQLiteBulkWriteError);
  });

  it('counts rows written and rows not written across batches', async () => {
    // maxVariables 2 with one key → two rows per batch.
    const { sql, deps } = failingRecorder(1);
    const { bulkWrite } = createBulk({ ...deps, maxVariables: 2 });

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
    const { sql, deps } = recorder();
    const { bulkWrite } = createBulk(deps);

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
    const { deps } = recorder();
    const { bulkWrite } = createBulk(deps);

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
      },
    };
  };

  // Falsifiable: memoize `swept` only when the sweep actually ran. If the lock
  // was held, another client was doing the work — retrying on every output()
  // would put a lock request in front of every single call.
  it('attempts the sweep once even when the lock is refused', async () => {
    const { attempts, locks } = refusing();
    const { sql, deps } = recorder();
    const { output } = createBulk({ ...deps, locks });

    await output('t', { a: 'INTEGER' }).close();
    await output('t', { a: 'INTEGER' }).close();

    expect(attempts()).toBe(1);
    expect(sql.some((s) => s.includes('sqlite_master'))).toBe(false);
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
  return {
    sql,
    deps: {
      write,
      read,
      transaction,
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
    },
  };
};

describe('output() staging and swap (B5)', () => {
  it('creates a staging table, never the target, before close()', async () => {
    const { sql, deps } = outputRecorder();
    const { output } = createBulk(deps);

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
    const { sql, deps } = outputRecorder();
    const { output } = createBulk(deps);

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
    const deps = {
      write: async (statement: string) => {
        sql.push(statement);
        if (statement.startsWith('INSERT')) throw new Error('constraint');
        calls++;
        return { result: [] as any[], affected: 0 };
      },
      read: async () => [] as any[],
      transaction: async <T>(cb: (db: any) => Promise<T>) => {
        sql.push('BEGIN');
        return cb({ write: async () => ({ result: [], affected: 0 }) });
      },
      file: 'app.db',
      locks: noOpLocks,
      logger: noopLogger,
    };
    const { output } = createBulk(deps as any);

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
