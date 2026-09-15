import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

/**
 * `OPFSCoopSyncVFS` rotates one exclusive OPFS access handle between workers,
 * and its `jLock` returns `SQLITE_BUSY` while a transfer is in flight — a step
 * of its own protocol, which upstream documents as expecting the caller to
 * retry. Nothing retried, so an ordinary read failed.
 *
 * Measured 2026-09-03, both engines: exactly one read per session, early, at
 * the default `poolSize`, recovering on the first immediate retry 7 times out
 * of 7 in 10-17 ms. `OPFSAdaptiveVFS` under the identical workload never fails,
 * which is what rules out "the workload is too aggressive".
 *
 * **The shape is load-bearing and a weaker one was tried first.** Awaiting a
 * write and THEN issuing reads does not reproduce it at all — that version
 * passed with the retry removed. Writes and reads have to be in flight
 * together, so the batch below mixes them and issues them at once.
 *
 * **2026-09-14, spec 2026-09-13 §10 (D9):** `OPFSCoopSyncVFS` now runs a
 * client on one worker on every engine, so the transfer this test chases can
 * no longer happen between workers of one pool — it happens between CLIENTS
 * instead, which is exactly what tabs do. The single client at `poolSize: 4`
 * below becomes two clients on the same file, each at its default (now
 * one-worker) pool, with the mixed batch split across both and issued at
 * once.
 *
 * **Client order is load-bearing, and a first attempt got it wrong.**
 * Constructing both clients together, before `dbA`'s `CREATE TABLE`
 * resolves, made a WRITE — not a read — fail with the transfer BUSY, which
 * `write()` does not retry. That was the same defect in the VFS, fixed by the
 * wa-sqlite patch on 2026-09-15 and pinned by `coopsync-handover.test.ts`.
 * This test opens `dbB` only after `dbA`'s first write settles, as a second
 * tab opening an already-running database would.
 *
 * **Falsifier, verified 2026-09-14, with clients opened in that order:**
 * dropping the catch from `readWithRetry` in `src/client.ts` — so it just
 * awaits `onReadLease` once, with no retry — turned this red on Firefox 3-4
 * of 5 runs, always a `read()` rejecting with `BUSY`, `sqliteCode` 5.
 *
 * **That falsifier is dead since the wa-sqlite patch of 2026-09-15.** The
 * same mutation left this test green 5 of 5 on Firefox: the VFS no longer
 * produces the BUSY the retry absorbed (COOPSYNC-HANDOVER,
 * `mem:measurements`). This test still pins that reads survive the handle
 * moving between two clients; it no longer guards `readWithRetry`, and no
 * other test exercises it (searched 2026-09-15).
 */

const CONCURRENT = 8;
const ROUNDS = 6;

const scrub = async (file: string) => {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(file, { recursive: true });
  } catch {
    // Never created, or already gone.
  }
};

describe('OPFSCoopSyncVFS handle-transfer BUSY', () => {
  it('does not surface the transfer BUSY to the caller', async () => {
    const file = `coopsync-retry-${crypto.randomUUID()}`;
    // dbA alone creates the table, exactly as the single client used to. dbB
    // only joins afterward, as a second tab opening an already-running
    // database would — each client at its default (capped) pool of one
    // worker, so the handle transfer this test chases now happens between
    // these two clients rather than between workers of one pool.
    const dbA = createSQLiteClient(file, { vfs: 'OPFSCoopSyncVFS' });
    try {
      await dbA.write('CREATE TABLE t (a INTEGER)');
      const dbB = createSQLiteClient(file, { vfs: 'OPFSCoopSyncVFS' });
      const clients = [dbA, dbB];
      try {
        for (let round = 0; round < ROUNDS; round++) {
          const work = Array.from({ length: CONCURRENT }, (_, i) => {
            const db = clients[i % clients.length];
            return i % 3 === 0
              ? db.write('INSERT INTO t (a) VALUES (?)', [
                  round * CONCURRENT + i,
                ])
              : db.read<{ n: number }>('SELECT count(*) AS n FROM t');
          });
          // Falsifiability, verified by experiment (see header): drop the
          // catch from `readWithRetry` in client.ts so it just awaits
          // `onReadLease`, and one of these rejects with SQLiteError code
          // BUSY, sqliteCode 5, "database is locked" — on Firefox.
          const settled = await Promise.allSettled(work);
          const rejected = settled.filter((s) => s.status === 'rejected');
          expect(rejected).toEqual([]);
        }
      } finally {
        await dbB.close().catch(() => {});
      }
    } finally {
      await dbA.close().catch(() => {});
      await scrub(file);
    }
  }, 120000);
});
