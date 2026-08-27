import { describe, expect, it } from '@rstest/core';
import { createTestClient, sleep } from './helpers';

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

describe('bulkWrite() and output() abort (ABORT-1)', () => {
  it('writes nothing when the abort beats the first batch', async () => {
    const db = await createTestClient();
    await db.write(wideTableDDL('bulk_abort_early'));

    const controller = new AbortController();
    const bulk = db.bulkWrite('bulk_abort_early', WIDE_COLUMNS, {
      signal: controller.signal,
    });

    // The auto-flush at WIDE_FLUSH_AT chains the batch, it does not await it.
    // Aborting in the same turn therefore reaches the batch before it runs —
    // and a batch that never started is a batch that must not start.
    for (let i = 1; i <= WIDE_FLUSH_AT; i++) bulk.enqueue(wideRow(i));
    controller.abort();

    await expect(bulk.close()).rejects.toMatchObject({ name: 'AbortError' });

    const [{ n }] = await db.read<{ n: number }>(
      'SELECT COUNT(*) AS n FROM bulk_abort_early',
    );
    expect(n).toBe(0);

    db.close();
  });

  it('stops between batches and keeps the ones already written', async () => {
    const db = await createTestClient();
    await db.write(wideTableDDL('bulk_abort'));

    const countRows = async () =>
      (await db.read<{ n: number }>('SELECT COUNT(*) AS n FROM bulk_abort'))[0]
        .n;

    const controller = new AbortController();
    const bulk = db.bulkWrite('bulk_abort', WIDE_COLUMNS, {
      signal: controller.signal,
    });

    for (let i = 1; i <= WIDE_FLUSH_AT; i++) bulk.enqueue(wideRow(i));

    // Wait for the first batch to actually land, so the abort below falls
    // BETWEEN batches. Without this the test measures the previous case.
    for (let i = 0; i < 200 && (await countRows()) === 0; i++) await sleep(20);
    expect(await countRows()).toBe(WIDE_FLUSH_AT);

    for (let i = 1; i <= 10; i++) bulk.enqueue(wideRow(WIDE_FLUSH_AT + i));
    controller.abort();

    await expect(bulk.close()).rejects.toMatchObject({ name: 'AbortError' });

    // bulkWrite is not atomic outside a transaction: the abort stops the load,
    // it does not undo it. The first batch is there and the table is usable —
    // which is the fact the README tells a caller to expect.
    expect(await countRows()).toBe(WIDE_FLUSH_AT);

    db.close();
  });

  it('leaves the previous table whole when output() is aborted', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE report (id INTEGER, label TEXT)');
    await db.write("INSERT INTO report VALUES (1, 'before')");

    const controller = new AbortController();
    const out = db.output(
      'report',
      { id: 'INTEGER', label: 'TEXT' },
      { signal: controller.signal },
    );
    out.enqueue({ id: 2, label: 'after' });
    controller.abort();

    await expect(out.close()).rejects.toMatchObject({ name: 'AbortError' });

    // Observationally a no-op: no rename, no partial publication.
    const rows = await db.read<{ id: number; label: string }>(
      'SELECT id, label FROM report',
    );
    expect(rows).toEqual([{ id: 1, label: 'before' }]);

    // And no staging table survives the abort.
    const staging = await db.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'",
    );
    expect(staging).toEqual([]);

    db.close();
  });
});
