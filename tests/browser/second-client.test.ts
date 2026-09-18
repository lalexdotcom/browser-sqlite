import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient, type WorkerLostEvent } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { SQLiteError } from '../../src/errors';
import {
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';
import { AVAILABLE_FEATURES } from '../conformance/helpers';
import {
  interceptWorkers,
  killSilently,
  sleep,
  TEST_TARGET,
  type WorkerRecord,
} from './helpers';
import { secondClientOutcome } from './helpers/vfs-contract';

/**
 * What a second client on the same database gets, on the (vfs, build) pair
 * this project injects — every pair, run by run, under `pnpm test:matrix`
 * (spec 2026-09-15, §4.1 and A6).
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

describe('a client whose worker 0 is lost before it answers the probe', () => {
  // Spec 2026-09-15, A3: every method settles. Worker 0 is terminated before
  // its first message and then dies, in the first round and in the retry, so
  // it never posts `probed`. On Chromium worker 2 has `readwrite-unsafe`,
  // does not decline and opens, so the pool is not empty — yet no answer
  // comes, nothing takes `bsq:conn`, and every method waited on it for ever.
  // On Firefox worker 2 declines, the pool empties and the client failed
  // already; the assertion is the same on both.
  //
  // First in this file on purpose: the answer is memoised per realm (A1) and
  // each test file runs in a fresh one. Once an OPFSWriteAheadVFS client here
  // has had its answer, a new client gets its own at construction and this
  // test cannot see the hang.
  //
  // Falsifier run 2026-09-15: deleting the `index === 0 && !probeSettled`
  // line of `onGateOpen` (src/client.ts) turns this red on both Chromium
  // projects — the query is still waiting at the bound.
  it("fails the client with that worker's error rather than hanging", async () => {
    // One VFS: the subject is the probe that only this VFS's exclusiveConnectionWithout triggers.
    const vfs = 'OPFSWriteAheadVFS' as const;
    const file = `second-client-${crypto.randomUUID()}`;
    const LOST = 'worker 0 lost before it answered the probe';
    // A bound on a hang, not a timing claim.
    const LOST_WITHIN = 10_000;
    const records = interceptWorkers();
    const record = records.push.bind(records);
    // Every worker told to probe is slot 0. interceptWorkers pushes a record
    // from inside the Worker constructor, before the client posts `open`, so
    // the wrapper below sees that first message.
    records.push = (...added: WorkerRecord[]) => {
      for (const { worker } of added) {
        const post = worker.postMessage.bind(worker) as (
          m: unknown,
          ...r: unknown[]
        ) => void;
        worker.postMessage = (message: unknown, ...rest: unknown[]) => {
          if ((message as { probeFirst?: unknown }).probeFirst === undefined) {
            post(message, ...rest);
            return;
          }
          killSilently(worker);
          setTimeout(() => {
            worker.dispatchEvent(new ErrorEvent('error', { message: LOST }));
          }, 0);
        };
      }
      return record(...added);
    };
    const db = createSQLiteClient(file, { vfs, poolSize: 2 });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs }).catch(() => {});
    });
    const outcome = await Promise.race([
      db.read('SELECT 1').then(
        () => 'resolved',
        (e: unknown) => e,
      ),
      sleep(LOST_WITHIN).then(() => 'still waiting'),
    ]);
    expect(outcome).toBeInstanceOf(SQLiteError);
    expect(outcome).toMatchObject({
      code: 'WORKER_CRASHED',
      message: expect.stringContaining(LOST),
    });
  });
});

{
  const { vfs, build } = TEST_TARGET;
  const outcome = secondClientOutcome(vfs);
  describe(`a second client is ${outcome} on the target`, () => {
    for (const shape of ['together', 'after'] as const) {
      const title = `built ${shape === 'together' ? 'together' : 'after the first write'}`;
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
          const { code, message, sqliteCode } = refusal as SQLiteError;
          expect(code).toBe('DATABASE_IN_USE');
          // Spec §3.2, step 4: the error names the VFS and — where a feature
          // this browser lacks is what makes the VFS exclusive — that
          // feature. It carries no `sqliteCode`, so `readWithRetry` does
          // not act on it.
          expect(message).toContain(vfs);
          const lacking = VFS_CAPABILITIES[vfs].exclusiveConnectionWithout.find(
            (f) => !AVAILABLE_FEATURES.has(f),
          );
          if (lacking !== undefined) {
            expect(message).toContain(`without ${lacking}`);
          }
          expect(sqliteCode).toBeUndefined();
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
  // closing is gone before `close()` resolves. Neither client-side guard has
  // an observed falsifier in it. Its one observed falsifier is on the worker
  // side (Task 4 review, 2026-09-15): deleting the waiting-`close` branch of
  // `src/worker/worker.ts` (`case 'close'` while `proceedGate` is set) makes
  // this test time out.
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
