import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient, type WorkerLostEvent } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { SQLiteError } from '../../src/errors';
import {
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';
import { ALL_VFS, missingHere } from '../conformance/helpers';
import { secondClientOutcome } from './helpers/vfs-contract';

/**
 * What a second client on the same database gets, for every VFS and every
 * build this browser can run (spec 2026-09-15, §4.1).
 *
 * Two clients in one page contend exactly as two tabs do: Web Locks, OPFS
 * access handles and IndexedDB are all origin-wide. The expectation is never
 * written here — `secondClientOutcome` derives it from `VFS_CAPABILITIES`, so a
 * VFS whose declaration stops matching what it does turns this file red.
 * `OPFSWriteAheadVFS` refused every second client on Firefox with
 * WORKER_CRASHED through the whole of rc.5's multi-client work, while every
 * multi-client test ran on one VFS.
 */

/** A refusal is fast or it is not one: AHP-2TAB's broken client looked healthy. */
const REFUSED_WITHIN = 3000;

const values = (rows: { n: number }[]) => rows.map((row) => row.n);

const oneDatabase = (vfs: SQLiteVFS, build: SQLiteBuild) => {
  const file = `second-client-${crypto.randomUUID()}`;
  const losses: string[] = [];
  const clients: ReturnType<typeof createSQLiteClient>[] = [];
  const open = (label: string) => {
    const client = createSQLiteClient(file, {
      vfs,
      build,
      onWorkerLost: ({ index, cause }: WorkerLostEvent) => {
        losses.push(`${label} worker ${index + 1}: ${cause.message}`);
      },
    });
    clients.push(client);
    return client;
  };
  onTestFinished(async () => {
    for (const client of clients) {
      try {
        await client.close();
      } catch {
        /* a failed client has nothing to close */
      }
    }
    try {
      await deleteDatabase(file, { vfs, build });
    } catch {
      /* never created, or already gone */
    }
  });
  return { file, open, losses };
};

for (const vfs of ALL_VFS) {
  const outcome = secondClientOutcome(vfs);
  describe(`${vfs}: a second client is ${outcome}`, () => {
    for (const build of VFS_CAPABILITIES[vfs].builds) {
      const missing = missingHere(vfs, build);
      for (const shape of ['together', 'after'] as const) {
        const title = `${build}, built ${shape === 'together' ? 'together' : 'after the first write'}`;
        if (missing !== null) {
          it.skip(`${title} — skipped, no ${missing} in this browser`, () => {});
          continue;
        }
        it(title, async () => {
          const { file, open, losses } = oneDatabase(vfs, build);
          const a = open('A');
          let b = shape === 'together' ? open('B') : undefined;
          await a.write('CREATE TABLE t (n)');
          await a.write('INSERT INTO t VALUES (1)');
          b ??= open('B');

          if (outcome === 'shared') {
            expect(
              values(await b.read<{ n: number }>('SELECT n FROM t')),
            ).toEqual([1]);
            await b.write('INSERT INTO t VALUES (2)');
            expect(
              values(await a.read<{ n: number }>('SELECT n FROM t ORDER BY n')),
            ).toEqual([1, 2]);
          } else if (outcome === 'isolated') {
            await expect(b.read('SELECT n FROM t')).rejects.toMatchObject({
              code: 'STATEMENT_FAILED',
            });
            await b.write('CREATE TABLE t (n)');
            await b.write('INSERT INTO t VALUES (9)');
            expect(
              values(await a.read<{ n: number }>('SELECT n FROM t')),
            ).toEqual([1]);
          } else {
            const started = performance.now();
            const refusal = await b.read('SELECT 1').then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(refusal).toBeInstanceOf(SQLiteError);
            expect((refusal as SQLiteError).code).toBe('DATABASE_IN_USE');
            expect(performance.now() - started).toBeLessThan(REFUSED_WITHIN);
            // The first client is untouched by the refusal.
            await a.write('INSERT INTO t VALUES (2)');
            expect(
              values(await a.read<{ n: number }>('SELECT n FROM t ORDER BY n')),
            ).toEqual([1, 2]);
            // The lock that refused B is the one deleteDatabase reads (spec §3.3).
            await expect(
              deleteDatabase(file, { vfs, build }),
            ).rejects.toMatchObject({
              code: 'DATABASE_IN_USE',
            });
            await a.close();
            // A refused client never recovers (D9); a new one opens once the
            // first is gone.
            const c = open('C');
            expect(
              values(await c.read<{ n: number }>('SELECT n FROM t ORDER BY n')),
            ).toEqual([1, 2]);
          }
          // A suite that proves a VFS works proves how many workers it worked
          // with (mem:lessons, 2026-09-13).
          expect(losses).toEqual([]);
        });
      }
    }
  });
}

describe('a client closed before worker 0 has answered', () => {
  // Spec 2026-09-15, §3.2 and A3 — the hazard the AccessHandlePoolVFS guard
  // paid a Critical defect for: a lock requested after close(), or a worker
  // left alive, would keep the next client out.
  //
  // Falsifiers run 2026-09-15: deleting `close()`'s
  // `probeAnswer?.resolve(undefined)`, or `|| closing` in `connLockPromise`,
  // or both, leaves this test GREEN — on Firefox alone and after the matrix,
  // and on Chromium alone. An answer always comes here: worker 0 handles
  // `open`, which posts `probed`, before it reads `close`, and once the
  // realm's memo is settled the answer comes at construction. And `close()`
  // awaits `connLockPromise` before it releases, so a lock taken while
  // closing is gone before `close()` resolves. This test proves the positive
  // path only; neither guard has an observed falsifier in it.
  it('closes promptly, holds no lock, and leaves the database to the next client', async () => {
    const vfs = 'OPFSWriteAheadVFS' as const;
    const file = `second-client-${crypto.randomUUID()}`;
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs }).catch(() => {});
    });
    const a = createSQLiteClient(file, { vfs });
    const started = performance.now();
    await a.close();
    expect(performance.now() - started).toBeLessThan(REFUSED_WITHIN);
    const held = ((await navigator.locks.query()).held ?? []).filter(
      (lock) =>
        lock.name?.startsWith('bsq:conn:') && lock.name.endsWith(`:${file}`),
    );
    expect(held).toEqual([]);
    const b = createSQLiteClient(file, { vfs });
    await b.write('CREATE TABLE t (n)');
    await b.close();
  });
});
