/**
 * `OPFSCoopSyncVFS` hands its one OPFS access handle to another connection on
 * request. Unpatched, it did so at the first `jUnlock(NONE)` it saw — and
 * SQLite can lock, unlock and lock again inside a single `step`, when it
 * re-prepares a cached statement whose schema went stale. The handle left at
 * the inner unlock, the relock returned `SQLITE_BUSY`, and wa-sqlite's
 * `retry()` gives a call two tries only: the BUSY reached the caller. The
 * patch in `patches/wa-sqlite@1.1.1.patch` defers the hand-over until the call
 * has returned.
 *
 * Measured 2026-09-15 (COOPSYNC-HANDOVER, `mem:measurements`), 20 attempts per
 * shape, before the patch and with a lock trace on: two clients opened
 * together failed a write 4-6/20 on Chromium and 15/20 on Firefox, always on
 * the barrier statement one client had prepared before its own CREATE TABLE;
 * a write following another client's CREATE TABLE failed 17-18/20 on Firefox
 * and never on Chromium. No other VFS produced a SQLite-reported BUSY in
 * either shape. Without the trace, this file still failed on both engines.
 *
 * **The hand-over waits for a task, not a microtask.** The JSPI build
 * suspends the WASM stack at every VFS call, so a microtask ran in the middle
 * of the `step` and gave the handle away exactly as before: a microtask
 * version cleared `sync` and `async` and still failed 9-18/20 on Firefox's
 * `jspi`. With a task, 720 probe attempts — three builds, two engines — saw
 * no BUSY at all, the reads `readWithRetry` used to absorb included.
 *
 * The same patch makes `#initialize` tolerate a temporary directory another
 * instance deleted first: two CoopSync workers starting together both tried to
 * delete the same orphaned `.ahp-*` directory, and the loser's `removeEntry`
 * threw `NotFoundError`, failing the whole client with `WORKER_CRASHED`.
 *
 * **The shapes are concurrent on purpose** (`mem:lessons`, "A regression test's
 * shape can delete the race it was written to pin"): each batch issues writes
 * and reads on both clients at once.
 */
import { describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

type Client = ReturnType<typeof createSQLiteClient>;

const ATTEMPTS = 20;
const CONCURRENT = 8;

/**
 * `sync` is the default build; `jspi` is where a microtask hand-over still
 * failed (see header), so the two handle-transfer tests run on both.
 */
const BUILDS = ['sync', 'jspi'] as const;

// One VFS: the subject is OPFSCoopSyncVFS's own handle hand-over protocol.
const open = (file: string, build: (typeof BUILDS)[number] = 'sync') =>
  createSQLiteClient(file, { vfs: 'OPFSCoopSyncVFS', build });

const describeError = (e: any) => `${e?.code}: ${e?.message}`;

const scrub = async (file: string) => {
  const root = await navigator.storage.getDirectory();
  for (const suffix of ['', '-journal', '-wal']) {
    await root.removeEntry(file + suffix).catch(() => {});
  }
};

/** Writes on A, reads on B, all issued at once; returns every rejection. */
const writesAgainstReads = async (dbA: Client, dbB: Client) => {
  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENT }, (_, i) =>
      i % 2 === 0
        ? dbA.write('INSERT INTO t (a) VALUES (?)', [i])
        : dbB.read('SELECT count(*) AS n FROM t'),
    ),
  );
  return settled.flatMap((s) =>
    s.status === 'rejected' ? [describeError(s.reason)] : [],
  );
};

/** One write in three, spread over both clients, all issued at once. */
const mixedBatch = async (dbA: Client, dbB: Client) => {
  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENT }, (_, i) => {
      const db = i % 2 === 0 ? dbA : dbB;
      return i % 3 === 0
        ? db.write('INSERT INTO t (a) VALUES (?)', [i])
        : db.read('SELECT count(*) AS n FROM t');
    }),
  );
  return settled.flatMap((s) =>
    s.status === 'rejected' ? [describeError(s.reason)] : [],
  );
};

describe('OPFSCoopSyncVFS hands the access handle over between calls only', () => {
  for (const build of BUILDS) {
    it(`two clients opened together fail no statement (${build})`, async () => {
      const failures: string[] = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const file = `coopsync-handover-${crypto.randomUUID()}`;
        // Both built before A's CREATE TABLE: A prepares its barrier statement
        // on the empty schema, so its first barrier after B's first write must
        // be re-prepared inside one `step` — the inner unlock the bug released at.
        const dbA = open(file, build);
        const dbB = open(file, build);
        try {
          await dbA.write('CREATE TABLE t (a INTEGER)');
          for (let round = 0; round < 3; round++) {
            failures.push(...(await mixedBatch(dbA, dbB)));
          }
        } catch (e) {
          failures.push(describeError(e));
        } finally {
          await dbB.close().catch(() => {});
          await dbA.close().catch(() => {});
          await scrub(file);
        }
      }
      expect(failures).toEqual([]);
    }, 120000);

    // Discriminates on Firefox only: Chromium never failed this shape unpatched.
    it(`a write following another client's schema change does not fail (${build})`, async () => {
      const failures: string[] = [];
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const file = `coopsync-handover-${crypto.randomUUID()}`;
        const dbA = open(file, build);
        let dbB: Client | undefined;
        try {
          await dbA.write('CREATE TABLE t (a INTEGER)');
          dbB = open(file, build);
          // Both clients' statements cached on the current schema first, so
          // the CREATE TABLE below is what makes them stale.
          failures.push(...(await writesAgainstReads(dbA, dbB)));
          await dbB.write('CREATE TABLE u (a INTEGER)');
          for (let round = 0; round < 2; round++) {
            failures.push(...(await writesAgainstReads(dbA, dbB)));
          }
        } catch (e) {
          failures.push(describeError(e));
        } finally {
          await dbB?.close().catch(() => {});
          await dbA.close().catch(() => {});
          await scrub(file);
        }
      }
      expect(failures).toEqual([]);
    }, 120000);
  }

  it('two clients starting together survive orphaned temporary directories', async () => {
    const root = await navigator.storage.getDirectory();
    const failures: string[] = [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      // No lock protects these, so every starting CoopSync worker deletes them
      // — both workers at once, over the same list.
      const orphans = Array.from(
        { length: 30 },
        () => `.ahp-orphan-${crypto.randomUUID()}`,
      );
      await Promise.all(
        orphans.map((name) => root.getDirectoryHandle(name, { create: true })),
      );
      const file = `coopsync-handover-${crypto.randomUUID()}`;
      const dbA = open(file);
      const dbB = open(file);
      try {
        const settled = await Promise.allSettled([
          dbA.read('SELECT 1 AS one'),
          dbB.read('SELECT 1 AS one'),
        ]);
        for (const s of settled) {
          if (s.status === 'rejected') failures.push(describeError(s.reason));
        }
      } finally {
        await dbB.close().catch(() => {});
        await dbA.close().catch(() => {});
        await scrub(file);
        for (const name of orphans) {
          await root.removeEntry(name, { recursive: true }).catch(() => {});
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120000);
});
