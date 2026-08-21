import { afterEach, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import type { InternalSQLiteClientOptions } from '../../src/scheduler';

/**
 * Creates a SQLite client with a unique database name (UUID) and registers
 * automatic OPFS cleanup via afterEach.
 *
 * Decisions: D-06 (unique name), D-07 (afterEach cleanup), D-08 (shared helper)
 * VFS: OPFSAdaptiveVFS on the Asyncify build by default — do not pass `vfs`
 * or `build` unless the test is about VFS selection itself.
 */
export async function createTestClient(
  options?: Omit<InternalSQLiteClientOptions, 'name'>,
) {
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
  return createSQLiteClient(dbName, options);
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

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A single very long `sqlite.step()` with no table to populate: SQLite must run
 * the whole recursion before the first row of `count(*)` exists.
 */
export const longQuery = (iterations: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${iterations}) SELECT count(*) AS n FROM c`;
