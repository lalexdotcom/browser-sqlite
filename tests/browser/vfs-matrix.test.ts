import { describe, expect, it } from '@rstest/core';
import type { SQLiteVFS } from '../../src/types';
import { createTestClient } from './helpers';

/**
 * THROWAWAY MEASUREMENT — choosing a default VFS.
 *
 * `OPFSPermutedVFS`, our current default, is deprecated upstream
 * (rhashimoto/wa-sqlite#317: "removed from testing and will not be updated"),
 * superseded by `OPFSWriteAheadVFS`. In #302 the author recommended
 * `OPFSAdaptiveVFS` with `lockPolicy: 'shared'` for exactly our shape — a pool
 * of workers reading concurrently.
 *
 * Three axes, in the order that decides:
 *
 *  1. CROSS-CONNECTION VISIBILITY. This is the one that matters most, because
 *     RYOW-1, the writer designation's stickiness, the two tests pinned to
 *     poolSize 1, and the commit-propagation barrier wave 4 still owes ALL
 *     exist because OPFSPermutedVFS propagates commits asynchronously over
 *     BroadcastChannel + IndexedDB. A VFS with no staleness dissolves four
 *     backlog items at once.
 *  2. POOL START-UP. #302 reports ~150 MB and ~10 s per worker for Permuted.
 *  3. CONCURRENT READ THROUGHPUT — the stated priority for the primary user.
 *
 * Every number here is Chromium-only: it is the only browser the suite runs.
 */

const POOL = 4;
const ROWS = 20_000;
const RYOW_ITERATIONS = 30;
const PARALLEL_READS = 8;

type Row = { n: number };

type Result = {
  vfs: string;
  initMs: number;
  seedMs: number;
  /** Reads that saw a count older than the write that had already resolved. */
  staleReads: number;
  readSamples: number;
  concurrentReadMs: number;
  failure?: string;
};

const results: Result[] = [];

const measure = async (vfs: SQLiteVFS): Promise<Result> => {
  const base: Result = {
    vfs,
    initMs: -1,
    seedMs: -1,
    staleReads: -1,
    readSamples: 0,
    concurrentReadMs: -1,
  };

  // 1. Pool start-up: every worker must be ready, not just the first.
  const startedInit = performance.now();
  const db = await createTestClient({ poolSize: POOL, vfs });
  await Promise.all(
    Array.from({ length: POOL }, () => db.read<Row>('SELECT 1 AS n')),
  );
  base.initMs = Math.round(performance.now() - startedInit);

  // 2. Cross-connection visibility. After a write RESOLVES, fan out one read
  // per worker: any that reports fewer rows than were committed saw a stale
  // view of the database.
  await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  let stale = 0;
  let samples = 0;
  for (let i = 1; i <= RYOW_ITERATIONS; i += 1) {
    await db.write('INSERT INTO t(id) VALUES (?)', [i]);
    const counts = await Promise.all(
      Array.from({ length: POOL }, () =>
        db.read<Row>('SELECT count(*) AS n FROM t'),
      ),
    );
    for (const rows of counts) {
      samples += 1;
      if ((rows[0]?.n ?? -1) < i) stale += 1;
    }
  }
  base.staleReads = stale;
  base.readSamples = samples;

  // 3. Concurrent reads over a table big enough to cost something.
  const startedSeed = performance.now();
  await db.write(
    `INSERT INTO t(id) SELECT x + ${RYOW_ITERATIONS} FROM (
       WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${ROWS})
       SELECT x FROM c)`,
  );
  base.seedMs = Math.round(performance.now() - startedSeed);

  const startedReads = performance.now();
  await Promise.all(
    Array.from({ length: PARALLEL_READS }, () =>
      db.read<Row>('SELECT count(*) AS n FROM t WHERE id % 7 = 0'),
    ),
  );
  base.concurrentReadMs = Math.round(performance.now() - startedReads);

  await db.close();
  return base;
};

describe('VFS matrix', () => {
  const candidates: SQLiteVFS[] = [
    'OPFSPermutedVFS',
    'OPFSWriteAheadVFS',
    'OPFSAdaptiveVFS',
    'OPFSAdaptiveAsyncVFS',
    'OPFSCoopSyncVFS',
    'IDBBatchAtomicVFS',
  ];

  for (const vfs of candidates) {
    it(`measures ${vfs}`, async () => {
      try {
        results.push(await measure(vfs));
      } catch (error) {
        // A VFS that cannot serve a pool of 4 is a result, not a crash.
        results.push({
          vfs,
          initMs: -1,
          seedMs: -1,
          staleReads: -1,
          readSamples: 0,
          concurrentReadMs: -1,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
      expect(results.length).toBeGreaterThan(0);
    }, 300_000);
  }

  // Deliberately red: browser console output is not forwarded to the terminal.
  it('reports', () => {
    throw new Error(`VFS-MATRIX ${JSON.stringify(results)}`);
  });
});
