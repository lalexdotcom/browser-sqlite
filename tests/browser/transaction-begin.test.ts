import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import {
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';
import { ALL_VFS, missingHere } from '../conformance/helpers';

/**
 * A transaction whose first statement does not write, on every VFS and every
 * build this browser can run (spec 2026-09-15, A4).
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

const fresh = (vfs: SQLiteVFS, build: SQLiteBuild) => {
  const file = `transaction-begin-${crypto.randomUUID()}`;
  const db = createSQLiteClient(file, { vfs, build });
  onTestFinished(async () => {
    try {
      await db.close();
    } catch {
      /* a failed client has nothing to close */
    }
    try {
      await deleteDatabase(file, { vfs, build });
    } catch {
      /* never created */
    }
  });
  return db;
};

for (const vfs of ALL_VFS) {
  describe(`${vfs}: a transaction that does not write first`, () => {
    for (const build of VFS_CAPABILITIES[vfs].builds) {
      const missing = missingHere(vfs, build);
      for (const [shape, { run, after, rows }] of Object.entries(SHAPES)) {
        const title = `${build}: ${shape}`;
        if (missing !== null) {
          it.skip(`${title} — skipped, no ${missing} in this browser`, () => {});
          continue;
        }
        it(title, async () => {
          const db = fresh(vfs, build);
          await db.write('CREATE TABLE t (n)');
          await db.write('INSERT INTO t VALUES (1)');
          await run(db);
          // The client is still usable: the failure left it broken for good.
          const [row] = await db.read<{ n: number }>(after);
          expect(row?.n).toBe(rows);
        });
      }
    }
  });
}
