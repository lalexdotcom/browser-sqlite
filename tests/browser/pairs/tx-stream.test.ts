import { describe, expect, it } from 'vitest';
import { createTestClient } from '../helpers';

/**
 * `tx.stream()` hands out rows of chunks the worker has already delivered:
 * what the transaction does to those buffered rows when it closes the stream,
 * when an abort lands, and when the consumer breaks out between two of them.
 */

const ROWS = 5_000;
const CHUNK_SIZE = 1_000;
const SERIES = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) SELECT x FROM c`;

const setUp = async () => {
  const db = await createTestClient({ poolSize: 1 });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

const bigCount = async (db: Db) =>
  (await db.read<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n;

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

  // Falsifiable: in tx.stream, hand flatten no signal — the buffered row 2 is
  // then served after the abort.
  it('a savepointed tx.stream() aborted mid-chunk rejects the next row and the write is not lost', async () => {
    const db = await setUp();
    const ctl = new AbortController();
    const reason = new Error('abort the stream');
    let first: IteratorResult<{ x: number }> | undefined;
    let second: unknown;
    const outcome = await db.transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)');
      const it = tx
        .stream<{ x: number }>(`INSERT INTO big ${SERIES} RETURNING x`, [], {
          chunkSize: CHUNK_SIZE,
          signal: ctl.signal,
        })
        [Symbol.asyncIterator]();
      first = await it.next();
      ctl.abort(reason);
      second = await it.next().then(
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
    expect((second as { rejected: unknown }).rejected).toBe(reason);
    expect(outcome).toBe('returned');
    expect(await rowsOf(db)).toEqual([1, 2]);
    expect(await bigCount(db)).toBe(0);
  });

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
});
