import { describe, expect, it } from 'vitest';
import {
  buildsHere,
  createTestClient,
  forEachCase,
  standalonePair,
  TEST_TARGET,
} from '../helpers';

/**
 * The worker's fast step (src/worker/step.ts) takes a different path per
 * build: the raw call on `sync` and `jspi` (a promise on `jspi`), a `ccall`
 * that returns a number or a promise on `async`. These tests pin what every
 * path must keep: every row arrives, and the worker serves the next query.
 */

const ROWS = 300_000;

describe('the fast step', {
  tags: ['standalone', 'excludes:shared-storage', 'requires:every-build'],
}, () => {
  // 300 000 rows exceed PROGRESS_OPS several times, so `async` and `jspi`
  // suspend mid-statement. Falsifiable: compare a `jspi` promise to
  // SQLITE_ROW instead of awaiting it and the row-count assertion fails.
  it('a long read returns every row, on every build', async ({ task }) => {
    const { vfs } = standalonePair(task.tags ?? []);
    await forEachCase(
      buildsHere(vfs),
      (build) => build,
      async (build) => {
        // `poolSize: 1`: a memory VFS's pages live in the worker that wrote them.
        const db = await createTestClient({ poolSize: 1 }, { vfs, build });
        try {
          await db.write('CREATE TABLE w (a INTEGER, b INTEGER)');
          await db.write(
            `INSERT INTO w WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${ROWS}) SELECT i, i * 7 FROM c`,
          );
          const total = (ROWS * (ROWS + 1)) / 2;
          expect(
            await db.read(
              'SELECT count(*) AS n, sum(a) AS sa, sum(b) AS sb FROM w',
            ),
          ).toEqual([{ n: ROWS, sa: total, sb: total * 7 }]);

          let received = 0;
          let sum = 0;
          for await (const rows of db.chunk<{ a: number; b: number }>(
            'SELECT a, b FROM w ORDER BY a',
            [],
            { chunkSize: 1000 },
          )) {
            received += rows.length;
            for (const row of rows) sum += row.a;
          }
          expect(received).toBe(ROWS);
          expect(sum).toBe(total);

          // The worker is healthy after its suspensions.
          expect(await db.first('SELECT 1 AS one')).toEqual({ one: 1 });
        } finally {
          await db.close();
        }
      },
    );
  });
});

describe('a checkpoint on the write-ahead VFS', () => {
  // A regression pin of a checkpoint through the worker. The VFS queues its
  // checkpoint at prepare (SQLITE_FCNTL_PRAGMA), where wa-sqlite's prepare retry() settles it, so
  // the step's `pendingOps` branch is covered by tests/unit/lib/step.test.ts only.
  it('a wal_checkpoint on OPFSWriteAheadVFS completes and the data stays readable', {
    tags: ['vfs:OPFSWriteAheadVFS'],
  }, async () => {
    const db = await createTestClient({ poolSize: 1 }, TEST_TARGET);
    await db.write('CREATE TABLE k (a INTEGER)');
    await db.write('INSERT INTO k VALUES (1), (2), (3)');
    await db.write('PRAGMA wal_checkpoint');
    expect(await db.read('SELECT a FROM k ORDER BY a')).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });
});
