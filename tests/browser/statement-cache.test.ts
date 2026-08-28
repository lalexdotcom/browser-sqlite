import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * `poolSize: 1` throughout this file. At the default size two executions of
 * the same SQL can land on two workers and compile once each — correct, and
 * unreadable as an assertion about caching.
 */
const single = { poolSize: 1, debug: true } as const;

/**
 * Every recorded execution of `sql`, oldest first. Selected by SQL rather
 * than by position: the barrier runs its own statement on the same worker,
 * so `queries.at(-1)` is not reliably the query the test just issued.
 */
const runsOf = (
  db: Awaited<ReturnType<typeof createTestClient>>,
  sql: string,
) =>
  (db.debug?.workers ?? [])
    .flatMap((w) => w.requests)
    .flatMap((r) => r.queries)
    .filter((q) => q.sql === sql);

describe('prepare counter', () => {
  it('reports one compilation for one statement', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    // Falsifiability: stop incrementing `prepared` in worker.ts's query loop
    // and this is 0.
    expect(runsOf(db, 'CREATE TABLE t (a)')[0]?.prepared).toBe(1);
    await db.close();
  });

  it('reports one compilation per statement of a multi-statement string', async () => {
    const db = await createTestClient(single);
    const sql = 'CREATE TABLE t (a); CREATE TABLE u (b)';
    await db.write(sql);
    // The premise Task 3 rests on, measured rather than assumed: wa-sqlite's
    // generator yields one statement per statement of the string.
    // Falsifiability: increment `prepared` once per query instead of once per
    // yielded statement and this is 1.
    expect(runsOf(db, sql)[0]?.prepared).toBe(2);
    await db.close();
  });
});

describe('statement cache', () => {
  it('compiles repeated SQL once', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t');
    await db.read('SELECT * FROM t');
    const runs = runsOf(db, 'SELECT * FROM t');
    expect(runs[0]?.prepared).toBe(1);
    // Falsifiability: return `undefined` unconditionally from `cache.get` and
    // this is 1.
    expect(runs[1]?.prepared).toBe(0);
    await db.close();
  });

  it('caches every shape that is one statement', async () => {
    const db = await createTestClient(single);
    // The cachable rows of spec §4.2, each executed twice.
    for (const sql of [
      'SELECT 1',
      'SELECT 1;',
      'SELECT 1\n  WHERE 1=1',
      'SELECT 1; ',
    ]) {
      await db.read(sql);
      await db.read(sql);
      // Falsifiability: replace `isSingleStatement(sql, sqlite.sql(stmt))` with
      // `false` unconditionally in the `else` branch of `query`, and all
      // entries become 1 (each run compiles, marked uncacheable on the first).
      expect(runsOf(db, sql)[1]?.prepared).toBe(0);
    }
    await db.close();
  });

  it('never caches a multi-statement string', async () => {
    const db = await createTestClient(single);
    const sql = 'SELECT 1; SELECT 2';
    await db.read(sql);
    await db.read(sql);
    // The false positive of spec §4.2, and the worst defect available here:
    // if `sqlite3_sql` returned the whole input rather than the statement's
    // own span, this string would be cached and every later execution would
    // run `SELECT 1` alone.
    // Falsifiability: replace the comparison in `isSingleStatement` with
    // `true` and this is 0.
    expect(runsOf(db, sql)[1]?.prepared).toBe(2);
    await db.close();
  });

  it('does not carry a binding from one execution to the next', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    const insert = 'INSERT INTO t (a) VALUES (?)';
    await db.write(insert, [7]);
    // bind_collection skips an `undefined` value, so on a reused statement
    // the previous execution's binding would survive (spec §2.3).
    await db.write(insert, [undefined]);
    const rows = await db.read<{ a: number | null }>(
      'SELECT a FROM t ORDER BY rowid',
    );
    // Falsifiability: delete the `clear_bindings` call in `settle` and the
    // second row is 7.
    expect(rows.map((r) => r.a)).toEqual([7, null]);
    await db.close();
  });

  it('closes cleanly after caching statements', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.read('SELECT * FROM t');
    // Verifies that close() resolves and does not reject after statements have
    // been cached. The drain's structural necessity — SQLite returns SQLITE_BUSY
    // when live statements exist — is not observable from JavaScript: the close
    // path's own catch{} swallows the error and the worker is terminated
    // either way, releasing OPFS handles. No edit to worker.ts makes this test
    // go red; the drain is a structural requirement covered by no falsifying test.
    await expect(db.close()).resolves.toBeUndefined();
  });

  it('caches a statement abandoned by first()', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1), (2)');
    const sql = 'SELECT a FROM t';
    await db.first(sql);
    await db.first(sql);
    // first() breaks out of the row loop after one row — a normal, hot exit.
    // Falsifiability: return `undefined` unconditionally from `cache.get` and
    // this is 1, because every call compiles the statement fresh.
    expect(runsOf(db, sql)[1]?.prepared).toBe(0);
    await db.close();
  });

  it('sees a column added after the statement was cached', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');
    await db.read('SELECT * FROM t');
    await db.write('ALTER TABLE t ADD COLUMN b');
    const rows = await db.read<Record<string, unknown>>('SELECT * FROM t');
    // The cached statement re-prepares itself during step() when the schema
    // has moved. Column names read before that step describe the old table
    // while row() returns the new one — correct values under wrong keys.
    // Falsifiability: move `cols ??= sqlite.column_names(stmt)` from inside
    // the SQLITE_ROW branch to `const cols = …` above the while-loop in
    // `run` and `b` is missing from the returned row.
    expect(Object.keys(rows[0] ?? {})).toEqual(['a', 'b']);
    await db.close();
  });
});
