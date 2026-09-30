import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { poolFor } from '../conformance/helpers';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  pairFor,
  type Skip,
  sleep,
  TEST_TARGET,
  waitUntil,
} from './helpers';

describe('debug subsystem (B6)', () => {
  it('is undefined when the option is absent', async () => {
    const db = await createTestClient();
    expect(db.debug).toBeUndefined();
    await db.close();
  });

  it('populates the whole chain after one read', async () => {
    const db = await createTestClient({ debug: true });

    await db.write('CREATE TABLE d (id INTEGER)');
    await db.write('INSERT INTO d (id) VALUES (1)');
    await db.read('SELECT id FROM d');

    const state = db.debug;
    expect(state).toBeDefined();

    // Not "a query with SELECT": the freshness barrier itself is a SELECT and
    // can land on a write's own request too, on a worker's first call.
    const request = state?.requests.find((r) => r.kind === 'read');
    if (!request) throw new Error('no read request recorded');
    expect(request).toBeDefined();
    expect(request.kind).toBe('read');
    expect(request.worker).toBeDefined();
    if (request.acquireTime === undefined)
      throw new Error('acquireTime not set');
    expect(request.acquireTime).toBeGreaterThanOrEqual(request.startTime);
    if (request.endTime === undefined) throw new Error('endTime not set');
    expect(request.endTime).toBeGreaterThanOrEqual(request.acquireTime);

    const query = request.queries.at(-1);
    if (!query) throw new Error('no query in request');
    expect(query.sql).toContain('SELECT');
    expect(query.endTime).toBeGreaterThan(0);
    expect(query.firstRowTime).toBeGreaterThan(0);
    expect(query.rows).toBe(1);
    expect(request.rows).toBe(
      request.queries.reduce((sum, q) => sum + q.rows, 0),
    );

    await db.close();
  });

  it('reads queue depths live from the scheduler', async () => {
    const db = await createTestClient({ debug: 'probe' });
    expect(db.debug?.queue.read).toBe(0);
    expect(db.debug?.queue.write).toBe(0);
    await db.close();
  });

  it('names the client the way its log lines are prefixed', async () => {
    const db = createSQLiteClient('debug-name.db', {
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      name: 'ledger',
      debug: true,
    });
    onTestFinished(() => db.close());
    expect(db.debug?.name).toMatch(/^ledger \d+$/);
  });
});

describe('the pool-level request history', () => {
  /** Holds the only worker in a transaction until `release()`. */
  const holdTheWorker = (db: Awaited<ReturnType<typeof createTestClient>>) => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const done = db.transaction(async () => {
      entered.resolve();
      await gate.promise;
    });
    return { entered: entered.promise, release: () => gate.resolve(), done };
  };

  // Falsifiable: create the request after `scheduler.acquire` in
  // acquireInstrumented — the queued read is then absent.
  it('shows a read queued behind a transaction before it has a worker', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const hold = holdTheWorker(db);
    await hold.entered;

    const queued = db.read('SELECT a FROM t');
    await waitUntil(
      () =>
        db.debug?.requests.some(
          (r) => r.kind === 'read' && r.acquireTime === undefined,
        ) ?? false,
      'the queued read in requests',
    );

    hold.release();
    await Promise.all([hold.done, queued]);
    const read = db.debug?.requests.findLast((r) => r.kind === 'read');
    if (!read) throw new Error('no read request found');
    // Date.now() has millisecond resolution: the two stamps can be equal.
    expect(read.acquireTime).toBeGreaterThanOrEqual(read.startTime);
    expect(read.endTime).toBeDefined();
  });

  // Falsifiable: drop `request?.failed(error)` from acquireInstrumented — the
  // aborted wait keeps no endTime and no error.
  it('keeps a wait aborted by its signal, with its error', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const hold = holdTheWorker(db);
    await hold.entered;

    const controller = new AbortController();
    const aborted = db.read('SELECT a FROM t', [], {
      signal: controller.signal,
    });
    await waitUntil(
      () => db.debug?.requests.some((r) => r.kind === 'read') ?? false,
      'the waiting read in requests',
    );
    controller.abort(new Error('gave up'));
    await expect(aborted).rejects.toBeDefined();

    const read = db.debug?.requests.find((r) => r.kind === 'read');
    if (!read) throw new Error('no read request found');
    expect(read.acquireTime).toBeUndefined();
    expect(read.endTime).toBeDefined();
    expect(read.error).toBeDefined();
    hold.release();
    await hold.done;
  });

  // Falsifiable: have createWorkerDebugState also drop the slot's entries from
  // `requests` — the crashed read disappears.
  it('keeps the requests of a killed worker, with its generation', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    const record = records[0];
    if (!record) throw new Error('no worker record');
    record.worker.dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    await db.read('SELECT 1 AS n');

    const debug = db.debug;
    if (!debug) throw new Error('debug not available');
    const { requests, workers } = debug;
    expect(workers[0]?.generation).toBe(1);
    const crashed = requests.find((r) =>
      r.queries.some((q) => q.sql.includes('WITH RECURSIVE')),
    );
    if (!crashed) throw new Error('no crashed request found');
    expect(crashed).toMatchObject({ worker: 0, generation: 0 });
    expect(crashed.endTime).toBeDefined();
    const query = crashed.queries.find((q) => q.sql.includes('WITH RECURSIVE'));
    if (!query) throw new Error('query not found in crashed request');
    expect(query.endTime).toBeDefined();
    expect(query.error).toMatchObject({ code: 'WORKER_CRASHED' });
    expect(requests.at(-1)).toMatchObject({ worker: 0, generation: 1 });
  });

  // Falsifiable: stop adding `rows` in the query handle's `chunk`.
  it('counts the rows delivered, and stops at what a first() received', async () => {
    const db = await createTestClient({ debug: true });
    await db.write('CREATE TABLE t (a)');
    await db.write(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000) INSERT INTO t SELECT x FROM c',
    );

    await db.read('SELECT a FROM t');
    await db.first('SELECT a FROM t');

    const dbDebug = db.debug;
    if (!dbDebug) throw new Error('debug not available');
    const reads = dbDebug.requests.filter((r) =>
      r.queries.some((q) => q.sql === 'SELECT a FROM t'),
    );
    const [all, first] = reads.map((r) =>
      r.queries.find((q) => q.sql === 'SELECT a FROM t'),
    );
    expect(all?.rows).toBe(1000);
    expect(first?.rows).toBeGreaterThanOrEqual(1);
    expect(first?.rows).toBeLessThan(1000);
  });
});

describe('the cross-tab write lock in the history', () => {
  const NEEDS = ['shared-second-client'] as const;

  const twoClients = (skip: Skip) => {
    const { vfs, build } = pairFor(NEEDS, skip);
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const options = { vfs, build, poolSize: poolFor(vfs) };
    const a = createSQLiteClient(dbName, options);
    const b = createSQLiteClient(dbName, { ...options, debug: true });
    onTestFinished(async () => {
      for (const client of [a, b]) await client.close().catch(() => {});
      await deleteDatabase(dbName, { vfs, build }).catch(() => {});
    });
    return { a, b };
  };

  // Falsifiable: drop `request?.locked()` from acquireLease — lockTime never appears.
  it('shows a write waiting on another client lock, then when it got it', async ({
    skip,
  }) => {
    const { a, b } = twoClients(skip);
    await a.write('CREATE TABLE t (a)');
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const holding = a.transaction(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;

    const blocked = b.write('INSERT INTO t VALUES (1)');
    await waitUntil(
      () => b.debug?.requests.some((r) => r.kind === 'write') ?? false,
      'the blocked write in requests',
    );
    await sleep(50);
    const waiting = b.debug?.requests.find((r) => r.kind === 'write');
    if (!waiting) throw new Error('no waiting write request');
    expect(waiting.lockTime).toBeUndefined();

    gate.resolve();
    await Promise.all([holding, blocked]);
    const write = b.debug?.requests.find((r) => r.kind === 'write');
    if (!write) throw new Error('no write request found');
    expect(write.lockTime).toBeDefined();
    if (write.lockTime === undefined) throw new Error('lockTime not set');
    if (write.acquireTime === undefined) throw new Error('acquireTime not set');
    expect(write.acquireTime).toBeGreaterThanOrEqual(write.lockTime);
  });
});
