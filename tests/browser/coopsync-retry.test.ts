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
    // poolSize 4 rather than the default 2: the trigger fired on every observed
    // run at 4 and only intermittently at 2, so 4 is what makes this bite
    // rather than pass vacuously.
    const db = createSQLiteClient(file, {
      vfs: 'OPFSCoopSyncVFS',
      poolSize: 4,
    });

    try {
      await db.write('CREATE TABLE t (a INTEGER)');

      for (let round = 0; round < ROUNDS; round++) {
        const work = Array.from({ length: CONCURRENT }, (_, i) =>
          i % 3 === 0
            ? db.write('INSERT INTO t (a) VALUES (?)', [round * CONCURRENT + i])
            : db.read<{ n: number }>('SELECT count(*) AS n FROM t'),
        );
        // Falsifiability, verified by experiment: drop the catch from
        // `readWithRetry` in client.ts so it just awaits `onReadLease`, and one
        // of these rejects with SQLiteError code BUSY, sqliteCode 5,
        // "database is locked".
        const settled = await Promise.allSettled(work);
        const rejected = settled.filter((s) => s.status === 'rejected');
        expect(rejected).toEqual([]);
      }
    } finally {
      await db.close().catch(() => {});
      await scrub(file);
    }
  }, 120000);
});
