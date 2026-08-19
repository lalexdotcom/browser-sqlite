import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * Characterization tests for `db.bulkWrite()`.
 *
 * `bulkWrite` batches rows to stay under SQLite's variable limit
 * (`SQLITE_MAX_VARS = 32766`): the buffer auto-flushes at
 * `floor(32766 / keys.length)` rows. The wide-table fixture below picks a
 * column count that makes that threshold small enough to cross in a test.
 */

/** 200 columns → auto-flush every floor(32766 / 200) = 163 rows. */
const WIDE_COLUMN_COUNT = 200;
const WIDE_FLUSH_AT = Math.floor(32766 / WIDE_COLUMN_COUNT);
const WIDE_COLUMNS = Array.from(
  { length: WIDE_COLUMN_COUNT },
  (_, i) => `c${i}`,
);

/** `c0 INTEGER PRIMARY KEY, c1 INTEGER, ... c199 INTEGER` */
const wideTableDDL = (table: string) =>
  `CREATE TABLE ${table} (${WIDE_COLUMNS.map((col, i) =>
    i === 0 ? `${col} INTEGER PRIMARY KEY` : `${col} INTEGER`,
  ).join(',')})`;

const wideRow = (id: number): Record<string, number> =>
  Object.fromEntries(WIDE_COLUMNS.map((col, i) => [col, i === 0 ? id : i]));

describe('bulkWrite() basics', () => {
  it('inserts every enqueued row and reports the affected count', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE bulk_basic (id INTEGER, name TEXT)');

    const bulk = db.bulkWrite('bulk_basic', ['id', 'name']);
    for (let i = 1; i <= 5; i++) {
      bulk.enqueue({ id: i, name: `row-${i}` });
    }
    const affected = await bulk.close();

    expect(affected).toBe(5);

    const rows = await db.read<{ id: number; name: string }>(
      'SELECT * FROM bulk_basic ORDER BY id',
    );
    expect(rows).toHaveLength(5);
    expect(rows[0].name).toBe('row-1');
    expect(rows[4].name).toBe('row-5');

    db.close();
  });

  it('resolves with 0 when nothing was enqueued', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE bulk_empty (id INTEGER)');

    const bulk = db.bulkWrite('bulk_empty', ['id']);
    const affected = await bulk.close();

    expect(affected).toBe(0);

    const rows = await db.read('SELECT id FROM bulk_empty');
    expect(rows).toHaveLength(0);

    db.close();
  });

  it('rejects when the insert violates a constraint', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE bulk_conflict (id INTEGER PRIMARY KEY)');

    const bulk = db.bulkWrite('bulk_conflict', ['id']);
    bulk.enqueue({ id: 1 });
    bulk.enqueue({ id: 1 });

    await expect(bulk.close()).rejects.toThrow();

    db.close();
  });
});

describe('bulkWrite() batching', () => {
  it('auto-flushes past the variable limit and keeps every row', async () => {
    const db = await createTestClient();

    await db.write(wideTableDDL('bulk_wide'));

    const total = WIDE_FLUSH_AT + 37;
    const bulk = db.bulkWrite('bulk_wide', WIDE_COLUMNS);
    for (let i = 1; i <= total; i++) {
      bulk.enqueue(wideRow(i));
    }
    const affected = await bulk.close();

    // Two batches: one auto-flush at WIDE_FLUSH_AT, one on close().
    expect(affected).toBe(total);

    const [{ n }] = await db.read<{ n: number }>(
      'SELECT COUNT(*) AS n FROM bulk_wide',
    );
    expect(n).toBe(total);

    db.close();
  });

  it('stops at the first failed batch and reports it', async () => {
    const db = await createTestClient();

    await db.write(wideTableDDL('bulk_drop'));

    const bulk = db.bulkWrite('bulk_drop', WIDE_COLUMNS);

    // First batch: every row shares the same PRIMARY KEY → the whole
    // multi-row INSERT fails, inserting nothing.
    for (let i = 0; i < WIDE_FLUSH_AT; i++) {
      bulk.enqueue(wideRow(1));
    }
    // Second batch: perfectly valid rows, which must NOT be silently lost.
    for (let i = 0; i < 10; i++) {
      bulk.enqueue(wideRow(1000 + i));
    }

    const error = await bulk.close().catch((e) => e);
    expect(error.code).toBe('BULK_WRITE_FAILED');
    expect(error.rowsWritten).toBe(0);
    expect(error.rowsNotWritten).toBe(WIDE_FLUSH_AT + 10);

    await db.close();
  });
});
