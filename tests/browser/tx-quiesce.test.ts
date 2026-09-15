import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) ' +
  'SELECT x FROM c';

/**
 * One mechanism, three faces. A transaction statement that leaves its transport
 * without reaching `done` exits through a `finally` that posts the stop and
 * fires `iterator.return()` WITHOUT awaiting it. `deferredChunk` in pool.ts
 * therefore clears only when a message comes back from the worker — a task —
 * while the next statement in the same callback is a microtask away, and meets
 * the reuse guard with `GENERATOR_ABANDONED`.
 *
 * Falsifiable for all three: remove the `await worker.quiesce()` that
 * src/transaction.ts owes each statement. Every test below then fails with
 * `GENERATOR_ABANDONED` on its SECOND statement. No CPU load and no flake
 * budget: the worker's reply needs a task and the next statement does not, so
 * the trip is deterministic rather than a race.
 */
describe('a statement following a short-circuited statement in the same callback', () => {
  it('follows tx.first()', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      const counted = await db.transaction(async (tx) => {
        // More than one row left to produce is the whole condition: first()
        // passes chunkSize 1 / credits 1, so the worker sends row 1, produces
        // row 2, finds no credit and parks holding it. A single-row result
        // ends by itself and breaks nothing.
        const row = await tx.first<{ n: number }>('SELECT n FROM t ORDER BY n');
        expect(row?.n).toBe(1);
        const rows = await tx.read<{ c: number }>(
          'SELECT count(*) AS c FROM t',
        );
        return rows[0]?.c;
      });

      expect(counted).toBe(2000);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('follows a tx.chunk() broken out of mid-callback', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      const counted = await db.transaction(async (tx) => {
        // Abandoned BETWEEN two statements, which closeOpenStatements() does
        // not reach: it runs at the end of the callback and nothing earlier.
        for await (const rows of tx.chunk<{ n: number }>(
          'SELECT n FROM t',
          [],
          { chunkSize: 10 },
        )) {
          expect(rows.length).toBe(10);
          break;
        }
        const rows = await tx.read<{ c: number }>(
          'SELECT count(*) AS c FROM t',
        );
        return rows[0]?.c;
      });

      expect(counted).toBe(2000);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('follows a tx.read() aborted by its own signal', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      const counted = await db.transaction(async (tx) => {
        const controller = new AbortController();
        // chunkSize 1 over 2000 rows keeps the query in flight for many tasks,
        // so the abort lands mid-read rather than after `done`; every step is
        // tiny, so the worker answers the stop at once.
        const pending = tx.read('SELECT n FROM t', [], {
          signal: controller.signal,
          chunkSize: 1,
        });
        await sleep(0);
        controller.abort();
        let rejected = false;
        try {
          await pending;
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);

        // The transaction's own signal never fired, so the callback runs on
        // and the next statement is the one that trips.
        const rows = await tx.read<{ c: number }>(
          'SELECT count(*) AS c FROM t',
        );
        return rows[0]?.c;
      });

      expect(counted).toBe(2000);
    } finally {
      await db.close();
    }
  }, 30_000);
});

describe('the boundary of that wait', () => {
  /**
   * The limit A cannot lift, pinned so the documentation stays true. A
   * generator that is `break`-ed out of, `return()`-ed or exhausted runs its
   * `finally`, and that is where the wait lives. One simply DROPPED runs
   * nothing at all — it stays suspended at its `yield`, holding the query —
   * so the next statement in the same callback still meets the reuse guard.
   * Nothing signals a drop, which is why the FinalizationRegistry exists and
   * why it is documented as best effort.
   */
  it('does not cover a generator the callback merely drops', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      let code: string | undefined;
      await db.transaction(async (tx) => {
        const rows = tx.chunk<{ n: number }>('SELECT n FROM t', [], {
          chunkSize: 10,
        });
        await rows.next();
        // Dropped, not closed: no `break`, no `return()`, no exhaustion.
        try {
          await tx.read('SELECT count(*) AS c FROM t');
        } catch (error) {
          code = (error as { code?: string }).code;
        }
      });

      expect(code).toBe('GENERATOR_ABANDONED');
    } finally {
      await db.close();
    }
  }, 30_000);
  /**
   * The same boundary reached through a generator rather than a promise, and
   * the reason `releasing`'s finally carries the same guard as `settled`: a
   * chunk() refused by the reuse guard must reject at once. Waiting for a
   * worker it never claimed would park this rejection behind the dropped
   * generator, which only closeOpenStatements() will close — at the end of
   * this callback, where the rejection was going. The two would deadlock, and
   * the transaction would hang instead of failing.
   */
  it('rejects a tx.chunk() refused by the guard instead of hanging', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      let code: string | undefined;
      await db.transaction(async (tx) => {
        const dropped = tx.chunk<{ n: number }>('SELECT n FROM t', [], {
          chunkSize: 10,
        });
        await dropped.next();
        try {
          await tx.chunk<{ n: number }>('SELECT n FROM t').next();
        } catch (error) {
          code = (error as { code?: string }).code;
        }
      });

      expect(code).toBe('GENERATOR_ABANDONED');
    } finally {
      await db.close();
    }
  }, 30_000);
  /**
   * Characterization, not a repair: this passes on arrival and guards the
   * SHAPE of the remaining failure. A drop that nobody catches must stay a
   * clean failure — the transaction rejects with the guard's own code, the
   * dropped generator is closed by closeOpenStatements() before the ROLLBACK
   * so the rollback does not trip in turn, no worker is evicted, and the
   * client still serves. Turning that into an eviction or a hang is the
   * regression this exists to catch.
   */
  // Falsifiable: comment out both closeOpenStatements() call sites in
  // src/transaction.ts — a worker is then evicted.
  it('fails cleanly when the drop is never caught', async () => {
    const records = interceptWorkers();
    // Both workers must stay alive and unevicted: needs two-workers so a
    // target that caps the pool without readwrite-unsafe (spec 2026-09-13,
    // §10) falls back to a pair that keeps two (spec 2026-09-15, A5).
    const db = await createTestClient({
      poolSize: 2,
      needs: ['two-workers'],
    });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      let code: string | undefined;
      try {
        await db.transaction(async (tx) => {
          const dropped = tx.chunk<{ n: number }>('SELECT n FROM t', [], {
            chunkSize: 10,
          });
          await dropped.next();
          await tx.read('SELECT count(*) AS c FROM t');
        });
      } catch (error) {
        code = (error as { code?: string }).code;
      }

      expect(code).toBe('GENERATOR_ABANDONED');
      expect(records.some((record) => record.terminated)).toBe(false);
      expect(records.length).toBe(2);

      const rows = await db.read<{ c: number }>('SELECT count(*) AS c FROM t');
      expect(rows[0]?.c).toBe(2000);
    } finally {
      await db.close();
    }
  }, 30_000);
});
