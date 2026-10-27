import { describe, expect, it } from 'vitest';
import { createTestClient, theQueryIsRunning, waitUntil } from '../helpers';

/**
 * `tx.stream()` hands out rows of chunks the worker has already delivered:
 * what the transaction does to those buffered rows when it closes the stream,
 * when an abort lands, and when the consumer breaks out between two of them.
 */

const ROWS = 5_000;
const CHUNK_SIZE = 1_000;
const SERIES = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) SELECT x FROM c`;

const setUp = async () => {
  const db = await createTestClient({ poolSize: 1, debug: true });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

const bigCount = async (db: Db) =>
  (await db.read<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n;

/** Steps for hundreds of milliseconds and inserts ten rows. */
const SLOW_INSERT =
  'INSERT INTO big SELECT x FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000) SELECT x FROM c) WHERE x % 100000 = 0 RETURNING x';

describe('tx.stream() between two rows of a chunk', () => {
  // Falsifiable: in tx.stream, leave `entry.gen` on releasing's generator —
  // the transaction then closes that one and the kept iterator serves row 2.
  it('a tx.stream() left open when the callback ends is closed, and serves no later row', async () => {
    const db = await setUp();
    let kept!: AsyncIterator<{ x: number }>;
    let first: IteratorResult<{ x: number }> | undefined;
    const outcome = await db.transaction(async (tx) => {
      kept = tx
        .stream<{ x: number }>(SERIES, [], { chunkSize: CHUNK_SIZE })
        [Symbol.asyncIterator]();
      first = await kept.next();
      return 'returned';
    });
    expect(outcome).toBe('returned');
    expect(first).toEqual({ value: { x: 1 }, done: false });
    expect(await kept.next()).toEqual({ value: undefined, done: true });
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  // Falsifiable: in flatten's return(), skip the source's return() on an open
  // iterator — releasing stays parked at its yield and the read waits for ever.
  it('a tx.stream() broken out of mid-chunk lets the next statement run', async () => {
    const db = await setUp();
    let seen = 0;
    let after: unknown;
    await db.transaction(async (tx) => {
      for await (const _row of tx.stream(SERIES, [], {
        chunkSize: CHUNK_SIZE,
      })) {
        seen++;
        break;
      }
      after = await tx.read('SELECT 1 AS one');
    });
    expect(seen).toBe(1);
    expect(after).toEqual([{ one: 1 }]);
  });

  // Falsifiable: in queries.ts's `drain`, end instead of throwing the reason
  // of a signal already aborted (B9) — the first next() then resolves `done`.
  it('a tx.stream() aborted before the first next rejects with the reason, and the transaction goes on', async () => {
    const db = await setUp();
    const ctl = new AbortController();
    const reason = new Error('abort before the first next');
    let first: unknown;
    let after: unknown;
    let read: unknown;
    const outcome = await db.transaction(async (tx) => {
      const rows = tx
        .stream(SERIES, [], { chunkSize: CHUNK_SIZE, signal: ctl.signal })
        [Symbol.asyncIterator]();
      ctl.abort(reason);
      first = await rows.next().then(
        (r) => ({ resolved: r }),
        (e: unknown) => ({ rejected: e }),
      );
      after = await rows.next();
      read = await tx.read('SELECT 1 AS one');
      return 'returned';
    });
    expect(first).toEqual({ rejected: reason });
    expect((first as { rejected: unknown }).rejected).toBe(reason);
    expect(after).toEqual({ value: undefined, done: true });
    expect(read).toEqual([{ one: 1 }]);
    expect(outcome).toBe('returned');
  });

  // Falsifiable: in tx.stream, pull the adapter once at the call — the stream
  // then takes its turn on the connection and the write waits behind it.
  it('a tx.stream() never pulled behind a statement holds up no later statement', async () => {
    const db = await setUp();
    let read: unknown;
    const outcome = await db.transaction(async (tx) => {
      const before = tx.read('SELECT 1 AS one');
      tx.stream(SERIES, [], { chunkSize: CHUNK_SIZE });
      read = await before;
      await tx.write('INSERT INTO t VALUES (7)');
      return 'returned';
    });
    expect(read).toEqual([{ one: 1 }]);
    expect(outcome).toBe('returned');
    expect(await rowsOf(db)).toEqual([7]);
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

describe('tx.stream() takes a write (spec 2026-10-26, § Streaming a write)', () => {
  // Falsifiable: put the `'stream'` method back in tx.stream's checksql() in
  // src/transaction.ts — the call then throws NOT_A_READ_QUERY.
  it('a tx.stream() INSERT … RETURNING delivers its rows and the transaction commits it', async () => {
    const db = await setUp();
    let seen = 0;
    let affected: number | undefined;
    await db.transaction(async (tx) => {
      const rows = tx.stream<{ x: number }>(
        `INSERT INTO big ${SERIES} RETURNING x`,
        [],
        { chunkSize: CHUNK_SIZE },
      );
      for await (const _row of rows) seen++;
      affected = await rows.affected;
    });
    expect(seen).toBe(ROWS);
    expect(affected).toBe(ROWS);
    expect(await bigCount(db)).toBe(ROWS);
  });

  // Falsifiable: in `releasing`, keep the write when its own signal lands
  // before `affected` too (skip the abandon) — the INSERT then stays.
  it('a savepointed tx.stream() write aborted before affected is undone, and the transaction commits the rest', async () => {
    const db = await setUp();
    const ctl = new AbortController();
    const reason = new Error('abort before affected');
    let caught: unknown;
    let affected: unknown;
    await db.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      const rows = tx.stream(SLOW_INSERT, [], { signal: ctl.signal });
      const pending = rows[Symbol.asyncIterator]().next();
      await waitUntil(theQueryIsRunning(db, SLOW_INSERT), 'the INSERT running');
      ctl.abort(reason);
      caught = await pending.catch((e: unknown) => e);
      affected = await rows.affected.catch((e: unknown) => ({ rejected: e }));
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(caught).toBe(reason);
    expect(affected).toEqual({ rejected: reason });
    expect(await bigCount(db)).toBe(0);
    expect(await rowsOf(db)).toEqual([1, 2]);
  });

  // Falsifiable: in `releasing`, undo on every abandon by the statement's own
  // signal, as before this branch — the INSERT is then rolled back.
  it('a savepointed tx.stream() write aborted between buffered rows after affected keeps its write, and the next statement runs', async () => {
    const db = await setUp();
    const ctl = new AbortController();
    const reason = new Error('abort after affected');
    let first: IteratorResult<{ x: number }> | undefined;
    let affected: number | undefined;
    let second: unknown;
    const outcome = await db.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      const stream = tx.stream<{ x: number }>(
        `INSERT INTO big ${SERIES} RETURNING x`,
        [],
        { chunkSize: CHUNK_SIZE, signal: ctl.signal },
      );
      const rows = stream[Symbol.asyncIterator]();
      first = await rows.next();
      affected = await stream.affected;
      ctl.abort(reason);
      second = await rows.next().then(
        (r) => ({ resolved: r }),
        (e: unknown) => ({ rejected: e }),
      );
      // Here, not after the callback: a row served instead keeps the stream
      // open, and the write below would wait behind it for ever.
      expect(second).toEqual({ rejected: reason });
      await tx.write('INSERT INTO t VALUES (2)');
      return 'returned';
    });
    expect(first).toEqual({ value: { x: 1 }, done: false });
    expect(affected).toBe(ROWS);
    expect((second as { rejected: unknown }).rejected).toBe(reason);
    expect(outcome).toBe('returned');
    expect(await rowsOf(db)).toEqual([1, 2]);
    expect(await bigCount(db)).toBe(ROWS);
  });
});
