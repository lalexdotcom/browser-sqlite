import { describe, expect, it, onTestFinished } from '@rstest/core';
import type { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { createTestClient } from './helpers';

/**
 * A transaction whose first statement does not write, on the (vfs, build) pair
 * this project injects — every pair, run by run, under `pnpm test:matrix`
 * (spec 2026-09-15, A4 and A6).
 *
 * OPFSWriteAheadVFS refuses a write transaction that did not announce itself at
 * BEGIN — "Write transaction cannot use BEGIN DEFERRED" — and the client stayed
 * unusable afterwards. `output()`'s swap starts with a DROP TABLE IF EXISTS that
 * writes nothing when the target is new, so `output()` failed there too.
 * Nothing caught it: every transaction test wrote first, and on one VFS.
 */

type Db = ReturnType<typeof createSQLiteClient>;

const SHAPES: Record<
  string,
  { run: (db: Db) => Promise<unknown>; after: string; rows: number }
> = {
  'reads, then writes': {
    run: (db) =>
      db.transaction(async (tx) => {
        await tx.read('SELECT n FROM t');
        await tx.write('INSERT INTO t VALUES (2)');
      }),
    after: 'SELECT count(*) AS n FROM t',
    rows: 2,
  },
  'runs a write that changes nothing, then writes': {
    run: (db) =>
      db.transaction(async (tx) => {
        await tx.write('DROP TABLE IF EXISTS missing');
        await tx.write('INSERT INTO t VALUES (2)');
      }),
    after: 'SELECT count(*) AS n FROM t',
    rows: 2,
  },
  'output() creates a table that does not exist yet': {
    run: async (db) => {
      const out = db.output('o', { n: 'INTEGER' });
      out.enqueue({ n: 1 });
      await out.close();
    },
    after: 'SELECT count(*) AS n FROM o',
    rows: 1,
  },
  'a readOnly transaction still reads': {
    run: (db) =>
      db.transaction(
        async (tx) => {
          await tx.read('SELECT n FROM t');
        },
        { readOnly: true },
      ),
    after: 'SELECT count(*) AS n FROM t',
    rows: 1,
  },
};

const fresh = async () => {
  const db = await createTestClient();
  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
    try {
      await deleteDatabase(db.file, { vfs: db.vfs, build: db.build });
    } catch {
      /* never created */
    }
  });
  return db;
};

describe('a transaction that does not write first', () => {
  for (const [shape, { run, after, rows }] of Object.entries(SHAPES)) {
    it(shape, async () => {
      const db = await fresh();
      await db.write('CREATE TABLE t (n)');
      await db.write('INSERT INTO t VALUES (1)');
      await run(db);
      // The client is still usable: the failure left it broken for good.
      const [row] = await db.read<{ n: number }>(after);
      expect(row?.n).toBe(rows);
    });
  }
});
