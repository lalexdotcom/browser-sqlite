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

  it('an aborted query leaves its cached statement reusable', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.write('INSERT INTO t VALUES (1)');

    // Slow enough that the signal fires while `step()` is still running. This
    // is the exit `first()` does not reach: there, the loop breaks after a row
    // has been served; here the gate stops it mid-statement.
    const sql =
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000) ' +
      'SELECT count(*) AS n FROM t CROSS JOIN (SELECT count(*) FROM c)';

    await db.read(sql);
    await expect(
      db.read(sql, [], { signal: AbortSignal.timeout(100) }),
    ).rejects.toThrow();

    // Falsifiability, verified by experiment: change `if (failed)` to
    // `if (failed || gate.isStopped())` in `settle` and this is 1 — the
    // aborted statement is then finalised and evicted rather than reset and
    // kept. What this test does NOT pin is that the abandoned statement left
    // no read transaction open; that half is not observable from JavaScript
    // and is recorded in `mem:follow-ups`.
    await db.read(sql);
    expect(runsOf(db, sql)[2]?.prepared).toBe(0);

    await db.close();
  });
});

/** 5 columns → bulkWrite flushes every floor(32766 / 5) = 6553 rows. */
const BULK_COLUMNS = ['c0', 'c1', 'c2', 'c3', 'c4'];
/** Four batches: three full templates and one partial. */
const BULK_ROWS = 20_000;

const bulkRow = (i: number) => ({ c0: i, c1: i, c2: i, c3: i, c4: i });

const feed = async (
  bulk: ReturnType<Awaited<ReturnType<typeof createTestClient>>['bulkWrite']>,
) => {
  for (let i = 0; i < BULK_ROWS; i++) await bulk.enqueue(bulkRow(i));
  return bulk.close();
};

/** Every INSERT batch the pool served, oldest first. */
const insertRuns = (db: Awaited<ReturnType<typeof createTestClient>>) =>
  (db.debug?.workers ?? [])
    .flatMap((w) => w.requests)
    .flatMap((r) => r.queries)
    .filter((q) => q.sql.startsWith('INSERT INTO'));

describe('the byte bound', () => {
  it('holds two statements at the default budget', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    const first = 'SELECT a FROM t';
    const second = 'SELECT a FROM t WHERE a = 1';
    await db.read(first);
    await db.read(second);
    await db.read(first);
    // THE CONTROL, and it is the one the 2026-09-02 campaign proved is
    // load-bearing: if the budget never reaches the worker it defaults to 0,
    // which evicts on every insertion of a DIFFERENT key, and the third read
    // compiles again.
    // Falsifiability: drop `statementCacheBytes` from the `open` postMessage
    // in pool.ts and this is 1.
    expect(runsOf(db, first)[1]?.prepared).toBe(0);
    await db.close();
  });

  it('evicts when the budget cannot hold the other entry', async () => {
    const db = await createTestClient({
      ...single,
      __unsafeTestStatementCacheBytes: 1,
    } as never);
    await db.write('CREATE TABLE t (a)');
    const first = 'SELECT a FROM t';
    await db.read(first);
    await db.read('SELECT a FROM t WHERE a = 1');
    await db.read(first);
    // A one-byte budget cannot hold the other statement, so each insertion
    // evicts its predecessor and the third read compiles.
    // Falsifiability: delete the byte loop from `insert` and this is 0.
    expect(runsOf(db, first)[1]?.prepared).toBe(1);
    await db.close();
  });

  it('retains a bulkWrite template across its batches', async () => {
    const db = await createTestClient(single);
    await db.write(`CREATE TABLE ta (${BULK_COLUMNS.join(',')})`);
    await feed(db.bulkWrite('ta', BULK_COLUMNS));
    const runs = insertRuns(db);
    // The full template weighs ~2.4 MB and is compiled once for three batches.
    // Falsifiability: return `undefined` unconditionally from `cache.get` and
    // every batch compiles.
    expect(runs.length).toBeGreaterThan(2);
    expect(runs[1]?.prepared).toBe(0);
    expect(runs[2]?.prepared).toBe(0);
    await db.close();
  });

  it('holds both templates of two concurrent bulkWrites', async () => {
    const db = await createTestClient(single);
    await db.write(`CREATE TABLE ta (${BULK_COLUMNS.join(',')})`);
    await db.write(`CREATE TABLE tb (${BULK_COLUMNS.join(',')})`);
    await Promise.all([
      feed(db.bulkWrite('ta', BULK_COLUMNS)),
      feed(db.bulkWrite('tb', BULK_COLUMNS)),
    ]);
    // Two writers interleave and their two FULL templates alternate. This is
    // the regression test for the measured +110 % on Firefox: a budget that
    // cannot hold them does not degrade the cache, it cancels it. Four
    // compilations is two full templates plus two partials.
    // Falsifiability: pass `__unsafeTestStatementCacheBytes: 2_000_000` —
    // below ONE template, which is what §3.1's `N − 1` requires — and this
    // climbs to one compilation per batch.
    const compiles = insertRuns(db).reduce((n, q) => n + q.prepared, 0);
    expect(compiles).toBeLessThanOrEqual(4);
    await db.close();
  });

  it('caches a template heavier than the whole budget', async () => {
    const db = await createTestClient({
      ...single,
      __unsafeTestStatementCacheBytes: 1024,
    } as never);
    await db.write(`CREATE TABLE ta (${BULK_COLUMNS.join(',')})`);
    await feed(db.bulkWrite('ta', BULK_COLUMNS));
    const runs = insertRuns(db);
    // The rule never refuses an entry and never reads the incoming weight: a
    // 2.4 MB template is admitted under a 1 KB budget, and because re-setting
    // it drops it first, nothing else is left to push the total over.
    // Falsifiability: add a "refuse to cache what does not fit" branch at the
    // top of `insert` and this is 1.
    expect(runs[1]?.prepared).toBe(0);
    await db.close();
  });
});
