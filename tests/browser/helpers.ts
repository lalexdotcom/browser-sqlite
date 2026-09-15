import { afterEach, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import type { InternalSQLiteClientOptions } from '../../src/scheduler';
import {
  defaultBuildFor,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from '../../src/types';
import { AVAILABLE_FEATURES } from '../conformance/helpers';
import { targetLabel } from '../target-projects';
import { type Here, type Need, resolvePair, type TestTarget } from './target';

/**
 * Options for createTestClient. `vfs` pins the test to one VFS; without it the
 * test follows the target, and `needs` declares what its subject requires of
 * the pair it runs on.
 */
type TestClientOptions = Omit<InternalSQLiteClientOptions, 'name' | 'vfs'> & {
  vfs?: SQLiteVFS;
  needs?: readonly Need[];
};

declare const __BSQ_TEST_TARGET__: TestTarget | undefined;

/**
 * The target this project injects — `source.define` in the browser configs,
 * one project per target (tests/target-projects.ts). A browser project without
 * one is a configuration error, not a default, so this throws rather than
 * choose a VFS. It lives here, not in `./target`, because the resolver there
 * is imported by a Node unit test, where no project injects anything.
 */
export const TEST_TARGET: TestTarget = (() => {
  if (typeof __BSQ_TEST_TARGET__ === 'undefined') {
    throw new Error(
      'TEST_TARGET: this project injects no __BSQ_TEST_TARGET__ — a browser project needs a target (tests/target-projects.ts)',
    );
  }
  return __BSQ_TEST_TARGET__;
})();

/** This browser, as the resolver sees it: the conformance probe's features. */
const HERE: Here = {
  features: AVAILABLE_FEATURES,
  crossOriginIsolated: globalThis.crossOriginIsolated === true,
};

/**
 * Creates a SQLite client with a unique database name (UUID) and registers
 * cleanup of its files via afterEach.
 *
 * Decisions: D-06 (unique name), D-07 (afterEach cleanup), D-08 (shared helper)
 *
 * VFS: the target this project injects (`TEST_TARGET`), unless the test pins
 * one with `vfs`. Pinning is for tests whose subject IS a VFS, and says why on
 * a `// One VFS: <reason>` line above the call; a pinned test runs on its
 * `build`, or that VFS's default. A property the subject requires of the pair
 * it runs on — two workers in the pool, an interruptible statement — is
 * declared in `needs`, never obtained by pinning: the test runs on the target
 * where the target has it here, otherwise on the nearest pair of this browser
 * that does (`resolvePair`, spec 2026-09-15, A5). No such pair is an error,
 * TARGET_NOT_RUNNABLE, never a skip.
 */
export async function createTestClient(options: TestClientOptions = {}) {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;
  const { needs = [], ...clientOptions } = options;
  const pair: TestTarget | null =
    options.vfs === undefined
      ? resolvePair(TEST_TARGET, needs, HERE)
      : {
          vfs: options.vfs,
          build: options.build ?? defaultBuildFor(options.vfs),
        };
  if (pair === null) {
    throw new Error(
      `TARGET_NOT_RUNNABLE: no pair of this browser runs ${targetLabel(TEST_TARGET)} with needs [${needs.join(', ')}]`,
    );
  }

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      // The database and every file a VFS keeps beside it — the three every
      // layout may have (DB_RELATED_SUFFIXES in src/worker/worker.ts) and the
      // VFS's own, such as OPFSWriteAheadVFS's -wa0/-wa1, which outlived every
      // test until 2026-09-15.
      for (const suffix of [
        '',
        '-journal',
        '-wal',
        ...VFS_CAPABILITIES[pair.vfs].extraFileSuffixes,
      ]) {
        await root
          .removeEntry(`${dbName}${suffix}`, { recursive: true })
          .catch(() => {});
      }
    } catch {
      // No OPFS here, or nothing was created.
    }
  });

  // createSQLiteClient is synchronous — workers initialize in the background.
  // The first query queues until a worker reaches READY.
  return createSQLiteClient(dbName, {
    ...clientOptions,
    vfs: pair.vfs,
    build: pair.build,
  } as InternalSQLiteClientOptions);
}

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

/** The worker has received the query and is executing it — i.e. status is RUNNING. */
export const aWorkerIsRunning =
  (db: Awaited<ReturnType<typeof createTestClient>>) => (): boolean =>
    (db.debug?.workers ?? []).some((w) => w.status === 'RUNNING');

/**
 * A single very long `sqlite.step()` with no table to populate: SQLite must run
 * the whole recursion before the first row of `count(*)` exists.
 */
export const longQuery = (iterations: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${iterations}) SELECT count(*) AS n FROM c`;
