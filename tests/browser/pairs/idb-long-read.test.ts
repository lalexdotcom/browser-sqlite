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
 *
 * No race between two durations (2026-11-17, `mem:follow-ups/safari-idb-long-read`):
 * the long statement never ends on its own, so the read either is served
 * while it runs or is never served. The read raced a ~0.6 s self-join before,
 * and on Safari's CI runners a read is served up to ~0.9 s into a long
 * statement — it lost 4 of 60 rounds with the library working.
 */
import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { scaled, TEST_TARGET, theQueryIsRunning, waitUntil } from '../helpers';

// Endless, and reading `t` from its first step: the read takes the SHARED
// lock that serialised the readers, and holds it for as long as the statement
// runs. A statement touching no table — `helpers.longQuery` — never locks the
// file and would pass whatever the VFS did.
const ENDLESS =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE (SELECT count(*) FROM t) > 0) SELECT count(*) AS n FROM c';

describe('IDBBatchAtomicVFS during a long statement', {
  tags: ['vfs:IDBBatchAtomicVFS'],
}, () => {
  // Falsifiable: stop installing the yielding progress handler in worker.ts
  // — the read then waits for a statement that never ends, and the test runs
  // out of time.
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
        // Interrupts the endless statement, or terminates its worker.
        await db.close({ immediate: true });
        await deleteDatabase(file, { vfs });
      });
      await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)');
      await db.run("INSERT INTO t (s) VALUES ('one'), ('two'), ('three')");
      // Both connections open and warm before the long statement starts.
      await Promise.all([
        db.all('SELECT s FROM t WHERE id = 2'),
        db.all('SELECT s FROM t WHERE id = 3'),
      ]);

      // No signal and no timeout: the path the handler had left out.
      let longSettled = false;
      const long = db.all(ENDLESS).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      void long.finally(() => {
        longSettled = true;
      });
      await waitUntil(
        theQueryIsRunning(db, ENDLESS),
        'the endless statement running',
      );

      const rows = await db.all<{ s: string }>('SELECT s FROM t WHERE id = 1');
      expect(rows).toEqual([{ s: 'one' }]);
      // Served while the statement still ran: it cannot have ended.
      expect(longSettled).toBe(false);
      expect(theQueryIsRunning(db, ENDLESS)()).toBe(true);

      await db.close({ immediate: true });
      expect(await long).toMatchObject({ code: 'CLIENT_CLOSED' });
    },
    scaled(60_000),
  );
});
