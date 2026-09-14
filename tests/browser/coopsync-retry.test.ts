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
 * resolves, made a WRITE — not a read — fail with the transfer BUSY: both
 * clients race to open the same file's cooperative handle from cold, and
 * `write()` has no retry (only `read()` and `first()` do). That reproduced
 * on both engines, non-deterministically (roughly half the runs), always at
 * the same spot (round 0's third write). It is a real gap — a cold-open race
 * between clients that the read-only retry does not cover — but it is a
 * different failure from the one this test exists for, and out of this
 * task's scope to fix in `src/`. Reported as a concern rather than silently
 * worked around. Creating `dbB` only after `dbA`'s `CREATE TABLE` settles —
 * as a second tab opening an already-running database would — removes that
 * race and lets the test target the transfer BUSY it was written for.
 *
 * **Falsifier, verified 2026-09-14, with clients opened in that order:**
 * dropping the catch from `readWithRetry` in `src/client.ts` — so it just
 * awaits `onReadLease` once, with no retry — turns this red on Firefox 4 of
 * 5 runs, always the same shape (a `read()` rejecting with `BUSY`,
 * `sqliteCode` 5). Chromium stayed green across the same 5 runs, as it did
 * before this rewrite. The transfer BUSY this test was written for
 * (measured 2026-09-03 at `poolSize: 4`, one client) still reproduces once
 * the handle is transferred between two separate clients' single workers
 * instead of between workers of one pool — which is what tabs do — and the
 * existing retry still covers it.
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
