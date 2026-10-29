/**
 * `IDBBatchAtomicVFS` serves a read while a long statement runs on another
 * worker, whether or not that statement carries a signal (2026-09-14).
 *
 * Its `jLock` opens a readwrite IndexedDB transaction on reaching SHARED, and
 * an IndexedDB transaction commits only once its thread returns to the event
 * loop. A worker inside one long statement never did unless a progress handler
 * yielded, so every other connection's SHARED lock queued behind it until the
 * statement ended — measured on both engines, `mem:measurements` IDB-SIGNAL.
 * The worker installs that handler on every statement.
 */
import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scaled, TEST_TARGET, theQueryIsRunning, waitUntil } from '../helpers';

const ROWS = 6000;
const FILL = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) INSERT INTO t (s) SELECT printf('%0100d', x) FROM c`;
// A self-join over a table, so it takes the SHARED lock that serialised the
// readers. A statement touching no table — `helpers.longQuery` — never locks
// the file and would pass whatever the VFS did.
const LONG = 'SELECT count(*) AS n FROM t a JOIN t b ON a.id < b.id';

describe('IDBBatchAtomicVFS during a long statement', {
  tags: ['vfs:IDBBatchAtomicVFS'],
}, () => {
  // Falsifiable: stop installing the yielding progress handler in worker.ts
  // — the read then waits the self-join out and loses the race.
  it(
    'serves a read from another worker without a signal',
    async () => {
      const { vfs, build } = TEST_TARGET;
      const file = `idb-long-read-${crypto.randomUUID()}`;
      const db = createSQLiteClient(file, {
        vfs,
        build,
        poolSize: 2,
        debug: true,
      });
      onTestFinished(async () => {
        await db.close();
        await deleteDatabase(file, { vfs });
      });
      await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)');
      await db.run(FILL);
      // Both connections open and warm before the race.
      await Promise.all([
        db.all('SELECT s FROM t WHERE id = 2'),
        db.all('SELECT s FROM t WHERE id = 3'),
      ]);

      let longSettled = false;
      const long = db.all(LONG).finally(() => {
        longSettled = true;
      });
      await waitUntil(
        theQueryIsRunning(db, LONG),
        'the long statement running',
      );
      // A long statement already over would prove nothing either way.
      expect(longSettled).toBe(false);

      const winner = await Promise.race([
        db.all('SELECT s FROM t WHERE id = 1').then(() => 'read'),
        long.then(() => 'long'),
      ]);
      await long;
      expect(winner).toBe('read');
    },
    scaled(60_000),
  );
});
