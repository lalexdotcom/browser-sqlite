import { describe, expect, it } from 'vitest';
import {
  type ClientOptions,
  createTestClient,
  scaled,
  sharedDatabase,
  theQueryIsRunning,
  waitUntil,
} from '../helpers';

/**
 * `stream()` and `chunk()` take a write: the worker steps it to its end before
 * the first row is delivered, so the write lock and the writer are free while
 * its rows are still being read (spec 2026-10-26, § Streaming a write).
 */

const ROWS = 2_000;
const SEED = `INSERT INTO t (a) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) SELECT x FROM c`;

/** Runs for hundreds of milliseconds before it deletes anything. */
const SLOW_DELETE =
  'DELETE FROM t WHERE a IN (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000) SELECT x FROM c) RETURNING a';

type Db = Awaited<ReturnType<typeof createTestClient>>;

const seed = async (db: Db) => {
  await db.write('CREATE TABLE t (a INTEGER PRIMARY KEY, b)');
  await db.write(SEED);
  return db;
};

const setUp = async (options: ClientOptions = {}) =>
  seed(await createTestClient(options));

const count = async (db: Db) =>
  (await db.all<{ n: number }>('SELECT count(*) AS n FROM t'))[0]?.n;

describe('stream() and chunk() take a write', () => {
  // Falsifiable: put assertReadable back in stream() in src/client.ts.
  it('stream() delivers every row of a DELETE … RETURNING, and the rows are gone', async () => {
    const db = await setUp();
    const seen: number[] = [];
    for await (const row of db.stream<{ a: number }>(
      'DELETE FROM t RETURNING a',
    )) {
      seen.push(row.a);
    }
    expect(seen.length).toBe(ROWS);
    expect(await count(db)).toBe(0);
  });

  // Falsifiable: in the worker's `run`, post `affected` after the kept chunks
  // instead of before them.
  it('affected resolves to the rows changed before the first row is delivered', async () => {
    const db = await setUp();
    const order: string[] = [];
    const rows = db.stream<{ a: number }>('DELETE FROM t RETURNING a');
    const iterator = rows[Symbol.asyncIterator]();
    const first = iterator.next().then((step) => {
      order.push('row');
      return step;
    });
    const affected = await rows.affected.then((n) => {
      order.push('affected');
      return n;
    });
    expect(affected).toBe(ROWS);
    expect((await first).done).toBe(false);
    expect(order).toEqual(['affected', 'row']);
    let rest = 0;
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      rest++;
    }
    expect(rest).toBe(ROWS - 1);
  });

  // Falsifiable: drop the releaseWriteLock() call from the streamed write's
  // onAffected in src/client.ts — the second client's INSERT then waits for
  // the stream to be read to its end.
  it("frees the write lock once affected resolved: another client's write does not wait for the rows", {
    tags: ['requires:shared-second-client'],
  }, async () => {
    const database = sharedDatabase();
    const db = await seed(database.open());
    const other = database.open();
    await other.all('SELECT 1');
    const rows = db.stream<{ a: number }>('DELETE FROM t RETURNING a', [], {
      chunkSize: 100,
    });
    const iterator = rows[Symbol.asyncIterator]();
    const first = iterator.next();
    expect(await rows.affected).toBe(ROWS);
    // The stream is not read past its first row while the other write runs.
    const outcome = await Promise.race([
      other.run('INSERT INTO t (a) VALUES (-1)').then(() => 'resolved'),
      new Promise((resolve) =>
        setTimeout(() => resolve('waited'), scaled(5_000)),
      ),
    ]);
    expect(outcome).toBe('resolved');
    expect((await first).done).toBe(false);
    let rest = 0;
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      rest++;
    }
    expect(rest).toBe(ROWS - 1);
    expect(await count(db)).toBe(1);
  });

  // Falsifiable: put assertReadable back in chunk() in src/client.ts.
  it('chunk() delivers an UPDATE … RETURNING in chunks of chunkSize', async () => {
    const db = await setUp();
    const rows = db.chunk<{ a: number }>('UPDATE t SET b = 1 RETURNING a', [], {
      chunkSize: 100,
    });
    let chunks = 0;
    let total = 0;
    for await (const chunk of rows) {
      chunks++;
      total += chunk.length;
    }
    expect(chunks).toBe(ROWS / 100);
    expect(total).toBe(ROWS);
    expect(await rows.affected).toBe(ROWS);
    expect(
      (
        await db.all<{ n: number }>('SELECT count(*) AS n FROM t WHERE b = 1')
      )[0]?.n,
    ).toBe(ROWS);
  });

  // Falsifiable: in the worker's `run`, skip the `affected` of a read — it
  // then settles only at the end, which the unread rows never reach.
  it('a read through stream() has affected 0 before its rows are read', async () => {
    const db = await setUp();
    const rows = db.stream<{ a: number }>('SELECT a FROM t');
    const iterator = rows[Symbol.asyncIterator]();
    const first = iterator.next();
    expect(await rows.affected).toBe(0);
    expect((await first).done).toBe(false);
    let seen = 1;
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      seen++;
    }
    expect(seen).toBe(ROWS);
  });

  // Falsifiable: in streamWithRetry's giveBack in src/client.ts, keep a write's
  // lease — the one worker never comes back and the SELECT waits.
  it('a DELETE … RETURNING broken out of after its first row has deleted every row, and the worker comes back', async () => {
    const db = await setUp({ poolSize: 1 });
    let seen = 0;
    for await (const _row of db.stream('DELETE FROM t RETURNING a', [], {
      chunkSize: 10,
    })) {
      seen++;
      break;
    }
    expect(seen).toBe(1);
    expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    expect(await count(db)).toBe(0);
  });

  // Falsifiable: in chunkRows in src/client.ts, hand the deadline's signal to
  // nothing — the DELETE then runs to its end and commits.
  it('an abort before affected leaves the table untouched', {
    tags: ['requires:interruptible'],
    timeout: scaled(30_000),
  }, async () => {
    const db = await setUp();
    const rows = db.stream(SLOW_DELETE, [], { timeout: 1 });
    await expect(
      (async () => {
        for await (const _row of rows) {
          // Never reached: the write is aborted before its first row.
        }
      })(),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await expect(rows.affected).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT',
    });
    expect(await count(db)).toBe(ROWS);
  });

  // Falsifiable: in chunkRows' write path in src/client.ts, hand chunkWorker
  // no signal — the worker is never stopped and the DELETE commits.
  it('an abort while the worker steps the write rolls it back', {
    tags: ['requires:interruptible'],
    timeout: scaled(30_000),
  }, async () => {
    const db = await setUp({ debug: true });
    const ctl = new AbortController();
    const reason = new Error('abort the drain');
    const rows = db.stream(SLOW_DELETE, [], { signal: ctl.signal });
    const outcome = (async () => {
      for await (const _row of rows) {
        // Never reached: the write is aborted before its first row.
      }
    })();
    await waitUntil(theQueryIsRunning(db, SLOW_DELETE), 'the DELETE running');
    ctl.abort(reason);
    await expect(outcome).rejects.toBe(reason);
    await expect(rows.affected).rejects.toBe(reason);
    expect(await count(db)).toBe(ROWS);
  });
});
