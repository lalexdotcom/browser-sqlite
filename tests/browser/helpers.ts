import { afterEach, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import type { InternalSQLiteClientOptions } from '../../src/scheduler';
import type { SQLiteVFS } from '../../src/types';

/** Options for createTestClient — vfs defaults to OPFSAdaptiveVFS. */
type TestClientOptions = Omit<InternalSQLiteClientOptions, 'name' | 'vfs'> & {
  vfs?: SQLiteVFS;
};

/**
 * Creates a SQLite client with a unique database name (UUID) and registers
 * automatic OPFS cleanup via afterEach.
 *
 * Decisions: D-06 (unique name), D-07 (afterEach cleanup), D-08 (shared helper)
 * VFS: OPFSAdaptiveVFS on the Asyncify build by default. Pass `vfs` when the
 * test is about VFS selection, or when it needs a pool of more than one worker
 * on every engine — OPFSAdaptiveVFS runs one where `readwrite-unsafe` is
 * missing, so such tests use OPFSAnyContextVFS (spec 2026-09-13, §10).
 */
export async function createTestClient(options: TestClientOptions = {}) {
  const dbName = `browser-sqlite-test-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      // OPFS entry may not exist if the test failed before DB creation
    }
  });

  // createSQLiteClient is synchronous — workers initialize in the background.
  // The first query queues until a worker reaches READY.
  const vfs: SQLiteVFS = options.vfs ?? 'OPFSAdaptiveVFS';
  return createSQLiteClient(dbName, {
    ...options,
    vfs,
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
