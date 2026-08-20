import { describe, expect, it } from '@rstest/core';
import { type SQLiteBuild, type SQLiteVFS, VFS_BUILDS } from '../../src/types';
import { createTestClient } from './helpers';

/**
 * THROWAWAY VERIFICATION — every VFS × build combination `VFS_BUILDS` declares.
 *
 * The capability table was taken from wa-sqlite's comparison table on master,
 * while this repository is pinned to v1.1.2. Declaring a combination that does
 * not actually run would surface as an opaque `open-error` from a worker that
 * could not instantiate its module, which is exactly the failure mode wave 2
 * spent effort removing. So each declared pair is run.
 *
 * Staleness is measured where it means something: a read that sees an older row
 * count than a write which had already RESOLVED. At `poolSize` 1 there is only
 * one connection, so it is reported as n/a rather than as a zero that flatters.
 */

const ITERATIONS = 10;

type Row = { n: number };

type Cell = {
  vfs: string;
  build: string;
  pool: number;
  ok: boolean;
  initMs: number;
  staleReads: number | null;
  readSamples: number;
  failure?: string;
};

const cells: Cell[] = [];

const verify = async (vfs: SQLiteVFS, build: SQLiteBuild): Promise<Cell> => {
  // AccessHandlePoolVFS cannot share access handles across connections and the
  // client refuses a larger pool at construction.
  const pool = vfs === 'AccessHandlePoolVFS' ? 1 : 4;
  const cell: Cell = {
    vfs,
    build,
    pool,
    ok: false,
    initMs: -1,
    staleReads: null,
    readSamples: 0,
  };

  const started = performance.now();
  const db = await createTestClient({ poolSize: pool, vfs, build });
  await Promise.all(
    Array.from({ length: pool }, () => db.read<Row>('SELECT 1 AS n')),
  );
  cell.initMs = Math.round(performance.now() - started);

  await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  if (pool > 1) {
    let stale = 0;
    let samples = 0;
    for (let i = 1; i <= ITERATIONS; i += 1) {
      await db.write('INSERT INTO t(id) VALUES (?)', [i]);
      const counts = await Promise.all(
        Array.from({ length: pool }, () =>
          db.read<Row>('SELECT count(*) AS n FROM t'),
        ),
      );
      for (const rows of counts) {
        samples += 1;
        if ((rows[0]?.n ?? -1) < i) stale += 1;
      }
    }
    cell.staleReads = stale;
    cell.readSamples = samples;
  } else {
    await db.write('INSERT INTO t(id) VALUES (1)');
    const rows = await db.read<Row>('SELECT count(*) AS n FROM t');
    expect(rows[0]?.n).toBe(1);
  }

  await db.close();
  cell.ok = true;
  return cell;
};

describe('declared VFS × build combinations', () => {
  const pairs: [SQLiteVFS, SQLiteBuild][] = Object.entries(VFS_BUILDS).flatMap(
    ([vfs, builds]) =>
      (builds as readonly SQLiteBuild[]).map(
        (build) => [vfs as SQLiteVFS, build] as [SQLiteVFS, SQLiteBuild],
      ),
  );

  for (const [vfs, build] of pairs) {
    it(`${vfs} on ${build}`, async () => {
      try {
        cells.push(await verify(vfs, build));
      } catch (error) {
        cells.push({
          vfs,
          build,
          pool: -1,
          ok: false,
          initMs: -1,
          staleReads: null,
          readSamples: 0,
          failure: error instanceof Error ? error.message : String(error),
        });
      }
      expect(cells.length).toBeGreaterThan(0);
    }, 300_000);
  }

  // Deliberately red: browser console output is not forwarded to the terminal.
  it('reports', () => {
    throw new Error(`VFS-BUILD-MATRIX ${JSON.stringify(cells)}`);
  });
});
