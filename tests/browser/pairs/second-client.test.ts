import {
  createSQLiteClient,
  deleteDatabase,
  SQLiteError,
} from 'browser-sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { WorkerLostEvent } from '../../../src/client';
import { VFS_CAPABILITIES } from '../../../src/const/vfs';
import { databasePath } from '../../../src/utils';
import {
  interceptWorkers,
  killSilently,
  sharedDatabase,
  sleep,
  TEST_TARGET,
  type WorkerRecord,
} from '../helpers';
import { AVAILABLE_FEATURES } from '../helpers/environment';

/**
 * What a second client on the same database gets, on the (vfs, build) pair
 * this project injects — every pair, run by run, under `pnpm test:matrix`
 * (spec 2026-09-15, §4.1 and A6).
 *
 * Two clients in one page contend exactly as two tabs do: Web Locks, OPFS
 * access handles and IndexedDB are all origin-wide. The expectation is never
 * written here — each test's tags declare it, so a VFS whose declaration stops
 * matching what it does turns this file red.
 * `OPFSWriteAheadVFS` refused every second client on Firefox with
 * WORKER_CRASHED through the whole of rc.5's multi-client work, while every
 * multi-client test ran on one VFS.
 */

const values = (rows: { n: number }[]) => rows.map((row) => row.n);

const oneDatabase = () => {
  const { name: file, open: openOn } = sharedDatabase();
  const losses: string[] = [];
  const open = (label: string) =>
    openOn({
      onWorkerLost: ({ index, cause }: WorkerLostEvent) => {
        losses.push(`${label} worker ${index + 1}: ${cause.message}`);
      },
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
  // The subject is the probe that only this VFS's exclusiveConnectionWithout
  // triggers; the build follows the cell's pair.
  it("fails the client with that worker's error rather than hanging", {
    tags: ['vfs:OPFSWriteAheadVFS'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
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
          // The error before the kill: Safari 26 and 27 deliver no event
          // dispatched on a terminated Worker, so the client never heard of
          // the death and waited out its 30 s open timeout (traced
          // 2026-10-23). The `open` is never posted, so nothing can answer.
          setTimeout(() => {
            worker.dispatchEvent(new ErrorEvent('error', { message: LOST }));
            killSilently(worker);
          }, 0);
        };
      }
      return record(...added);
    };
    const db = createSQLiteClient(file, { vfs, build, poolSize: 2 });
    onTestFinished(async () => {
      await db.close().catch(() => {});
      await deleteDatabase(file, { vfs, build }).catch(() => {});
    });
    const outcome = await Promise.race([
      db.all('SELECT 1').then(
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

/** Client A's first two writes, then client B: together or after them. */
const setUp = async (shape: 'together' | 'after') => {
  const { file, open, losses } = oneDatabase();
  const a = open('A');
  let b = shape === 'together' ? open('B') : undefined;
  await a.run('CREATE TABLE t (n)');
  await a.run('INSERT INTO t VALUES (1)');
  b ??= open('B');
  return { file, open, losses, a, b };
};

// What a second client gets is one of three outcomes, each declared by the
// pair's properties: it shares the database, is refused, or gets a database
// of its own, and the tags below send each pair to the tests that are its own.
const sharesTheDatabase = (shape: 'together' | 'after') => async () => {
  const { losses, a, b } = await setUp(shape);

  expect(values(await b.all<{ n: number }>('SELECT n FROM t'))).toEqual([1]);
  await b.run('INSERT INTO t VALUES (2)');
  expect(
    values(await a.all<{ n: number }>('SELECT n FROM t ORDER BY n')),
  ).toEqual([1, 2]);
  // A suite that proves a VFS works proves how many workers it worked
  // with (mem:lessons, 2026-09-13).
  expect(losses).toEqual([]);
};

const isRefused = (shape: 'together' | 'after') => async () => {
  const { vfs, build } = TEST_TARGET;
  const { file, open, losses, a, b } = await setUp(shape);

  const refusal = await b.all('SELECT 1').then(
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
  // Falsifiable: drop `readyDeferred.reject(fatal)` from failClient —
  // `ready` then never settles and the test times out.
  await expect(b.ready).rejects.toMatchObject({
    code: 'DATABASE_IN_USE',
  });
  // The first client is untouched by the refusal.
  await a.run('INSERT INTO t VALUES (2)');
  expect(
    values(await a.all<{ n: number }>('SELECT n FROM t ORDER BY n')),
  ).toEqual([1, 2]);
  // The lock that refused B is the one deleteDatabase reads (spec §3.3).
  await expect(deleteDatabase(file, { vfs, build })).rejects.toMatchObject({
    code: 'DATABASE_IN_USE',
  });
  await a.close();
  // A refused client never recovers (D9); a new one opens once the
  // first is gone.
  const c = open('C');
  expect(
    values(await c.all<{ n: number }>('SELECT n FROM t ORDER BY n')),
  ).toEqual([1, 2]);
  expect(losses).toEqual([]);
};

const getsItsOwnDatabase = (shape: 'together' | 'after') => async () => {
  const { losses, a, b } = await setUp(shape);

  await expect(b.all('SELECT n FROM t')).rejects.toMatchObject({
    code: 'STATEMENT_FAILED',
  });
  await b.run('CREATE TABLE t (n)');
  await b.run('INSERT INTO t VALUES (9)');
  expect(values(await a.all<{ n: number }>('SELECT n FROM t'))).toEqual([1]);
  expect(losses).toEqual([]);
};

describe('a second client on the target', () => {
  it(
    'built together, shares the database',
    {
      tags: ['requires:shared-second-client'],
    },
    sharesTheDatabase('together'),
  );
  it(
    'built together, is refused',
    {
      tags: ['requires:exclusive-connection'],
    },
    isRefused('together'),
  );
  it(
    'built together, gets a database of its own',
    {
      tags: ['excludes:shared-storage'],
    },
    getsItsOwnDatabase('together'),
  );
  it(
    'built after the first write, shares the database',
    {
      tags: ['requires:shared-second-client'],
    },
    sharesTheDatabase('after'),
  );
  it(
    'built after the first write, is refused',
    {
      tags: ['requires:exclusive-connection'],
    },
    isRefused('after'),
  );
  it(
    'built after the first write, gets a database of its own',
    {
      tags: ['excludes:shared-storage'],
    },
    getsItsOwnDatabase('after'),
  );
});

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
  it('closes promptly, holds no lock, and leaves the database to the next client', {
    tags: ['vfs:OPFSWriteAheadVFS'],
  }, async () => {
    const { vfs, build } = TEST_TARGET;
    const file = `second-client-${crypto.randomUUID()}`;
    onTestFinished(async () => {
      await deleteDatabase(file, { vfs, build }).catch(() => {});
    });
    const a = createSQLiteClient(file, { vfs, build });
    // Settling at all is the subject: a close that waits for worker 0 forever
    // is caught by the test's own timeout.
    await a.close();
    const held = ((await navigator.locks.query()).held ?? []).filter(
      (lock) =>
        lock.name?.startsWith('bsq:conn:') &&
        lock.name.endsWith(`:${databasePath(vfs, file)}`),
    );
    expect(held).toEqual([]);
    const b = createSQLiteClient(file, { vfs, build });
    await b.run('CREATE TABLE t (n)');
    await b.close();
  });
});
