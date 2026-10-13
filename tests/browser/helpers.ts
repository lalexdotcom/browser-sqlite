import { createSQLiteClient, deleteDatabase } from 'browser-sqlite';
import { expect, inject, onTestFinished } from 'vitest';
import type { SQLiteDB } from '../../src/api';
import type { SQLiteBuild } from '../../src/const/builds';
import {
  folderOf,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/const/vfs';
import type { InternalSQLiteClientOptions } from '../../src/scheduler';
import type { SQLiteError } from '../../src/types/errors';
import { databaseFiles, databasePath } from '../../src/utils';
import { AVAILABLE_FEATURES, removeOpfsPath } from '../conformance/helpers';
import { needFromTags, representative, runsIn } from '../need';
import type { TestTarget } from './target';

let targetReads = 0;

/**
 * The pair this project provides (vitest.config.ts, one project per declared
 * pair, tests/target-projects.ts). A browser project without one is a
 * configuration error, not a default, so this throws rather than choose a VFS.
 * Read it inside a test or a helper, never at module or describe scope.
 */
export const TEST_TARGET: TestTarget = (() => {
  const target = inject('bsqTarget');
  if (target === undefined) {
    throw new Error(
      'TEST_TARGET: this project provides no bsqTarget — a browser project needs a target (tests/target-projects.ts)',
    );
  }
  // Getters, so the trace (tests/browser/trace.ts) can tell a test that
  // follows its pair from one that opens a VFS of its own.
  return Object.freeze({
    get vfs() {
      targetReads++;
      return target.vfs;
    },
    get build() {
      targetReads++;
      return target.build;
    },
  });
})();

/** The reads of `TEST_TARGET` since the last call (the trace's counter). */
export const takeTargetReads = (): number => {
  const reads = targetReads;
  targetReads = 0;
  return reads;
};

/** This project's family (vitest.config.ts provides it beside the target). */
export const ENVIRONMENT = inject('bsqEnvironment');

/**
 * The pair a standalone test uses here: the first canonical pair its own
 * tags admit (spec § 3), never a name written in the test. Throws when none
 * does — the planner lists such a test as not applicable and never runs it.
 */
export const standalonePair = (tags: readonly string[]): TestTarget => {
  const pair = representative(
    needFromTags(tags).need,
    ENVIRONMENT.browser,
    AVAILABLE_FEATURES,
  );
  if (pair === null) {
    throw new Error(`STANDALONE: no pair here satisfies [${tags.join(', ')}]`);
  }
  return { vfs: pair.vfs, build: pair.build };
};

/** The builds of a VFS this browser can run, as declared. */
export const buildsHere = (vfs: SQLiteVFS): SQLiteBuild[] =>
  (VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).filter((build) =>
    runsIn({
      vfs,
      build,
      browser: ENVIRONMENT.browser,
      isolated: false,
      features: AVAILABLE_FEATURES,
    }),
  );

/**
 * Runs every case whatever the others do, then fails once naming each case
 * that failed (user, 2026-10-12): a loop that stops at its first failure
 * hides how many cases share it.
 */
export const forEachCase = async <T>(
  cases: readonly T[],
  label: (item: T) => string,
  run: (item: T) => Promise<void>,
): Promise<void> => {
  const failures: string[] = [];
  for (const item of cases) {
    try {
      await run(item);
    } catch (error) {
      failures.push(
        `${label(item)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  expect(failures).toEqual([]);
};

/**
 * Removes a database file and every file a VFS keeps beside it — the three
 * every layout may have, and the VFS's own (e.g. OPFSWriteAheadVFS's
 * -wa0/-wa1, which outlived every test until 2026-09-15). Shared by
 * createTestClient's own cleanup and by tests that open a worker directly
 * with createPoolWorker, bypassing the client and its cleanup
 * (pool-savepoint.test.ts, abandon.test.ts).
 */
export const removeDatabaseFiles = async (
  name: string,
  vfs: SQLiteVFS,
): Promise<void> => {
  for (const path of databaseFiles(vfs, databasePath(vfs, name)))
    await removeOpfsPath(path);
};

/**
 * Closes `clients`, then deletes `name` on `pair` and removes its files — the
 * one cleanup of `createTestClient` and `sharedDatabase`.
 */
const cleanUp = async (
  name: string,
  pair: TestTarget,
  clients: readonly SQLiteDB[],
): Promise<void> => {
  // Closing first is what lets the deletion below happen at all —
  // deleteDatabase refuses with DATABASE_IN_USE while a client holds the
  // connection lock. A client the test deliberately poisoned may refuse to
  // close, which is that test's subject, not this cleanup's.
  for (const client of clients) await client.close().catch(() => {});
  // AccessHandlePoolVFS (OPFS without a folder, the only one) holds a FIXED pool of
  // six OPFS files and hands a slot back on its own xDelete alone: jClose
  // returns nothing, and the path→handle association is written into the
  // OPFS file header, so it outlives the worker, the page and the whole
  // run. Since every test opens a fresh UUID name, the sixth test exhausts
  // the origin and nothing opens afterwards. removeDatabaseFiles cannot
  // help — that VFS keeps its files under opaque names inside its own
  // directory, so removing the database's name matches nothing.
  //
  // NOT swallowed, and that is the point. This call used to end in
  // `.catch(() => {})`; it was failing on every test that had just killed a
  // busy worker — the dying worker still held the directory — so the slot
  // leaked, the pool ran out, and the next tests failed for a reason nobody
  // could see. The silence cost a full day (`mem:lessons`). A cleanup that
  // cannot clean must say so.
  const { storage } = VFS_CAPABILITIES[pair.vfs];
  if (
    storage === 'indexeddb' ||
    (storage === 'opfs' && folderOf(pair.vfs) === undefined)
  ) {
    // IndexedDB keeps its database, and AccessHandlePoolVFS its slot, until
    // deleteDatabase: removing files by name reaches neither.
    await withNativeWorker(() =>
      deleteDatabase(name, { vfs: pair.vfs, build: pair.build }),
    ).catch((error: unknown) => {
      // DATABASE_NOT_FOUND only: the client never got as far as creating
      // the file, or the test deleted it itself. Anything else — a slot
      // this cleanup could not give back — must reach the test.
      if ((error as SQLiteError)?.code !== 'DATABASE_NOT_FOUND') throw error;
    });
  }
  await removeDatabaseFiles(name, pair.vfs);
};

/**
 * Creates a SQLite client with a unique database name (UUID) on `pair` —
 * this project's (`TEST_TARGET`) unless a standalone test hands it the pair
 * it resolved — and closes and deletes it when the test ends.
 *
 * Decisions: D-06 (unique name), D-07 (per-test cleanup), D-08 (shared helper).
 */
export async function createTestClient(
  options: ClientOptions = {},
  pair: TestTarget = TEST_TARGET,
) {
  const dbName = `bsq-test-${crypto.randomUUID()}`;
  const resolved: TestTarget = { vfs: pair.vfs, build: pair.build };
  // createSQLiteClient is synchronous — workers initialize in the background.
  // The first query queues until a worker reaches READY.
  const db = createSQLiteClient(dbName, {
    ...options,
    vfs: resolved.vfs,
    build: resolved.build,
  } as InternalSQLiteClientOptions);
  // onTestFinished, NOT afterEach: afterEach registered from inside a test
  // body is suite-scoped, not test-scoped — under rstest it never ran.
  onTestFinished(() => cleanUp(dbName, resolved, [db]));
  return db;
}

/** What a test may set on a client it opens: everything but where. */
export type ClientOptions = Omit<InternalSQLiteClientOptions, 'vfs' | 'build'>;

/**
 * One database, on this project's pair, that a test opens as many clients on
 * as its subject needs, each when it decides and with its own options;
 * `spelling` opens it under another spelling of the same name (`./name`).
 * Every client is closed and the database deleted when the test ends.
 */
export const sharedDatabase = (): {
  name: string;
  open: (options?: ClientOptions, spelling?: string) => SQLiteDB;
} => {
  const name = `bsq-shared-${crypto.randomUUID()}`;
  const pair: TestTarget = { vfs: TEST_TARGET.vfs, build: TEST_TARGET.build };
  const clients: SQLiteDB[] = [];
  onTestFinished(() => cleanUp(name, pair, clients));
  return {
    name,
    open: (options = {}, spelling = name) => {
      const client = createSQLiteClient(spelling, {
        ...options,
        vfs: pair.vfs,
        build: pair.build,
      } as InternalSQLiteClientOptions);
      clients.push(client);
      return client;
    },
  };
};

export type WorkerRecord = {
  worker: Worker;
  posted: string[];
  received: string[];
  /** Ordered trace: 'post:<type>', 'recv:<type>', 'terminate'. */
  log: string[];
  terminated: boolean;
};

/**
 * Records every Worker the client creates, and optionally redirects them to
 * another URL so a load failure can be produced for real.
 *
 * Production code has no test seam by design: the tests reach the workers by
 * replacing the constructor the client calls, not by asking the client to
 * accept a factory.
 */
export function interceptWorkers(options?: { url?: string }): WorkerRecord[] {
  const records: WorkerRecord[] = [];
  const Original = globalThis.Worker;

  class Recording extends Original {
    constructor(url: string | URL, workerOptions?: WorkerOptions) {
      super(options?.url ?? url, workerOptions);
      const record: WorkerRecord = {
        worker: this,
        posted: [],
        received: [],
        log: [],
        terminated: false,
      };
      records.push(record);
      this.addEventListener('message', (event: MessageEvent) => {
        const type = String((event.data as { type?: string })?.type);
        record.received.push(type);
        record.log.push(`recv:${type}`);
      });
      const post = this.postMessage.bind(this);
      this.postMessage = (message: unknown, ...rest: unknown[]) => {
        const type = String((message as { type?: string })?.type);
        record.posted.push(type);
        record.log.push(`post:${type}`);
        return (post as (m: unknown, ...r: unknown[]) => void)(
          message,
          ...rest,
        );
      };
      const terminate = this.terminate.bind(this);
      this.terminate = () => {
        record.terminated = true;
        record.log.push('terminate');
        terminate();
      };
    }
  }

  globalThis.Worker = Recording as unknown as typeof Worker;
  // onTestFinished is scoped to the current test (unlike afterEach which is
  // suite-scoped when called inside a test body). This ensures the original
  // Worker constructor is restored before the next test's interceptWorkers()
  // call captures it, so Recording classes never accidentally extend each other.
  onTestFinished(() => {
    globalThis.Worker = Original;
  });
  return records;
}

/**
 * The engine's own terminate, captured before any interception replaces it.
 *
 * `PoolWorker.terminate()` is no longer the browser's method: it poisons the
 * transport first, deliberately, so that a termination WE decide produces an
 * error instead of a silent hang. A test that wants to simulate the ENGINE
 * killing a worker — the thread stops and nothing tells the library — has to
 * reach past that, which is what this is for. Using `worker.terminate()` for
 * that purpose no longer simulates anything.
 */
const NativeWorker = globalThis.Worker;

/**
 * Runs `fn` with the browser's own `Worker`. A test that intercepts workers
 * restores them in an `onTestFinished` registered BEFORE `createTestClient`'s,
 * and Vitest runs those hooks in reverse: the cleanup's `deleteDatabase`, which
 * spawns a worker on a VFS without a folder, would go through the test's
 * broken constructor.
 */
const withNativeWorker = async <T>(fn: () => Promise<T>): Promise<T> => {
  const current = globalThis.Worker;
  globalThis.Worker = NativeWorker;
  try {
    return await fn();
  } finally {
    globalThis.Worker = current;
  }
};

/** Stops the thread and tells the library nothing, as an engine kill does. */
export const killSilently = (worker: Worker): void => {
  NativeWorker.prototype.terminate.call(worker);
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the predicate is true, yielding to the macrotask queue between
 * checks. Used to observe scheduler state without a fixed-duration sleep.
 *
 * BOUNDED, and it must be: the states below are transient, so a predicate that
 * is never observed used to spin here until the test itself timed out at 30 s
 * with no indication of what had been waited for. Failing at 5 s with the
 * thing named is the difference between a diagnosis and a mystery.
 */
export const waitUntil = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(0);
  }
};

/**
 * A worker is executing `sql` itself. Not merely "a worker is RUNNING": a
 * worker behind on the epoch runs the freshness barrier before the query, so
 * an abort timed on any running statement can land during the barrier, and
 * the query under test is then never sent.
 */
export const theQueryIsRunning =
  (db: Awaited<ReturnType<typeof createTestClient>>, sql: string) =>
  (): boolean =>
    (db.debug?.requests ?? []).some((request) => {
      const query = request.queries.at(-1);
      return (
        request.worker !== undefined &&
        request.endTime === undefined &&
        db.debug?.workers[request.worker]?.status === 'RUNNING' &&
        query?.sql === sql &&
        query.endTime === undefined
      );
    });

/**
 * A single very long `sqlite.step()` with no table to populate: SQLite must run
 * the whole recursion before the first row of `count(*)` exists.
 */
export const longQuery = (iterations: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${iterations}) SELECT count(*) AS n FROM c`;

/** `longQuery` with its iteration count bound, so one cached statement serves every N. */
export const LONG_QUERY =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c';
