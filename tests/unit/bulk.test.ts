import { describe, expect, it } from '@rstest/core';
import { createBulk } from '../../src/bulk';
import { BulkWriteError } from '../../src/errors';

/** Records every statement the unit under test emits. */
const recorder = () => {
  const sql: string[] = [];
  const write = async (statement: string) => {
    sql.push(statement);
    return { result: [] as any[], affected: 0 };
  };
  return { sql, write };
};

describe('bulkWrite quoting (B4)', () => {
  it('quotes the table and every column in the INSERT', async () => {
    const { sql, write } = recorder();
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('my table', ['a b', 'c']);
    bulk.enqueue({ 'a b': 1, c: 2 });
    await bulk.close();

    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('INSERT INTO "my table"');
    expect(sql[0]).toContain('("a b","c")');
  });

  it('neutralises an injection in the table name', async () => {
    const { sql, write } = recorder();
    const { bulkWrite } = createBulk({ write });

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
  return { sql, write };
};

describe('bulkWrite failure (B5)', () => {
  it('does not attempt later batches once one fails', async () => {
    const { sql, write } = failingRecorder(0);
    const { bulkWrite } = createBulk({ write });

    // keys.length 1 → maxBufferSize is 32766; flush explicitly instead.
    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    const first = bulk.close();
    await expect(first).rejects.toBeInstanceOf(BulkWriteError);

    expect(sql).toHaveLength(1);
  });

  it('rejects close() with the original error as cause', async () => {
    const { write } = failingRecorder(0);
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });

    const error = await bulk.close().catch((e) => e);
    expect(error).toBeInstanceOf(BulkWriteError);
    expect(error.code).toBe('BULK_WRITE_FAILED');
    expect((error.cause as Error).message).toMatch(/UNIQUE/);
  });

  it('throws from enqueue() once the latch is set', async () => {
    const { write } = failingRecorder(0);
    const { bulkWrite } = createBulk({ write });

    const bulk = bulkWrite('t', ['a']);
    bulk.enqueue({ a: 1 });
    await bulk.close().catch(() => {});

    expect(() => bulk.enqueue({ a: 2 })).toThrow(BulkWriteError);
  });

  it('counts rows written and rows not written across batches', async () => {
    // maxVariables 2 with one key → two rows per batch.
    const { sql, write } = failingRecorder(1);
    const { bulkWrite } = createBulk({ write, maxVariables: 2 });

    // Batch 1 (rows 1-2) succeeds, batch 2 (rows 3-4) fails,
    // batch 3 (row 5, flushed by close) is never attempted.
    const bulk = bulkWrite('t', ['a']);
    for (const a of [1, 2, 3, 4, 5]) bulk.enqueue({ a });
    const error = await bulk.close().catch((e) => e);

    expect(error).toBeInstanceOf(BulkWriteError);
    expect(error.rowsWritten).toBe(2);
    expect(error.rowsNotWritten).toBe(3);
    expect(sql).toHaveLength(2); // the third batch was never sent
  });
});
