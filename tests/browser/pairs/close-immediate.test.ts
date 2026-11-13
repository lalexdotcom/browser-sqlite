import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  exercised,
  interceptWorkers,
  longQuery,
  scaled,
  sharedDatabase,
  theQueryIsRunning,
  waitUntil,
} from '../helpers';

/** A write slow enough to still be running when close() looks at it. */
const SLOW_INSERT_ROWS = 2_000_000;
const SLOW_INSERT =
  'INSERT INTO t (a) WITH RECURSIVE c(x) AS ' +
  `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${SLOW_INSERT_ROWS}) ` +
  'SELECT x FROM c';

/** A request holds a worker it has not handed back — i.e. a write is live. */
const aRequestIsInFlight =
  (db: Awaited<ReturnType<typeof createTestClient>>) => () =>
    (db.debug?.requests ?? []).some(
      (request) =>
        // Not the verdict that classifies the statement first: it ends before
        // the statement's own request starts.
        request.kind !== 'verdict' &&
        request.acquireTime !== undefined &&
        request.endTime === undefined,
    );

/** Rows enough for a stream to still have some after its first chunk. */
const ENDLESS_ROWS =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 10000000) SELECT x FROM c';

describe('close({ immediate: true })', () => {
  // Falsifiable: leave immediateAbort un-aborted in close() — the statement
  // runs to its end (minutes), well past the bound.
  it('interrupts a running statement and closes the worker cleanly', {
    tags: ['requires:interruptible'],
  }, async () => {
    const records = interceptWorkers();
    // drainTimeout left at its default: a drain would wait it out. The grace is
    // raised: this test asserts the worker closed cleanly, which holds only
    // while the grace outlasts the machine, and the grace is not its subject.
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
      closeImmediateGrace: scaled(10_000),
    } as never);
    // Prime: cached, so the real run takes run(cached) and its step starts
    // before the interruption (as interrupt.test.ts's "frees the worker").
    await db.all(longQuery(1_000));
    const long = db.all(longQuery(2_000_000_000));
    long.catch(() => {});
    await waitUntil(
      theQueryIsRunning(db, longQuery(2_000_000_000)),
      'the query to be running',
    );

    const t0 = performance.now();
    await db.close({ immediate: true });

    await expect(long).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));
    const trace = records[0].log;
    expect(trace).toContain('recv:closed');
    expect(trace.indexOf('terminate')).toBeGreaterThan(
      trace.indexOf('recv:closed'),
    );
  });

  // Falsifiable: leave immediateAbort un-aborted — the paused consumer is
  // waited out for drainTimeout (60 s) and the next() is never refused.
  it('rejects a paused chunk() at once', async () => {
    // chunk(): the next() of a paused consumer meets the abort at once.
    // stream() below: it still hands the rows of the chunk it was in.
    const db = await createTestClient({ poolSize: 1 });
    const rows = db.chunk(ENDLESS_ROWS, [], { chunkSize: 10 });
    const iterator = rows[Symbol.asyncIterator]();
    await iterator.next();

    const t0 = performance.now();
    await db.close({ immediate: true });
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'CLIENT_CLOSED',
    });
  });

  // Falsifiable: leave immediateAbort un-aborted — the paused consumer is
  // waited out for drainTimeout (60 s) and the iteration is never ended.
  it('ends a paused stream() in CLIENT_CLOSED', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const rows = db.stream(ENDLESS_ROWS, [], { chunkSize: 10 });
    const iterator = rows[Symbol.asyncIterator]();
    await iterator.next();

    const t0 = performance.now();
    await db.close({ immediate: true });
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));

    // The rest of the chunk it was in may still arrive, then the rejection.
    let failure: unknown;
    for (let i = 0; i < 1_000 && failure === undefined; i++) {
      try {
        const next = await iterator.next();
        if (next.done) break;
      } catch (error) {
        failure = error;
      }
    }
    expect(failure).toMatchObject({ code: 'CLIENT_CLOSED' });
  });

  // Pins the outcome; does not discriminate the option from the default, which
  // already abandons the transaction through closeSignal (measured: the same
  // test passes without the option).
  it('does not wait for a transaction that never finishes', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.run('CREATE TABLE t (a)');
    const entered = Promise.withResolvers<void>();
    const transaction = db.transaction(async () => {
      entered.resolve();
      await new Promise(() => {}); // never settles
    });
    const settled = transaction.then(
      () => 'resolved',
      (error: { code?: string }) => error.code ?? 'unknown',
    );
    await entered.promise;

    const t0 = performance.now();
    await db.close({ immediate: true });
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));
    await expect(settled).resolves.toBe('CLIENT_CLOSED');
  });

  // Pins the outcome, which does not discriminate the option from the default:
  // bulk.ts records a batch refused by the client as a failure (the load's own
  // signal is not the one that fired), so close() rejects with
  // BULK_WRITE_FAILED and CLIENT_CLOSED as its cause, not with CLIENT_CLOSED.
  it("rejects a bulk load's close()", async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.run('CREATE TABLE t (a)');
    const load = db.bulkWrite('t', ['a']);
    for (let i = 0; i < 5; i++) load.enqueue({ a: i });

    await db.close({ immediate: true });
    await expect(load.close()).rejects.toMatchObject({
      code: 'BULK_WRITE_FAILED',
      cause: { code: 'CLIENT_CLOSED' },
    });
  });

  // Falsifiable: drop the terminate-at-once branch in close() — the grace path
  // posts `close` first, which the trace then holds.
  it('terminates a statement it cannot stop, without asking it to close', {
    tags: ['build:sync', 'excludes:interruptible'],
  }, async () => {
    const records = interceptWorkers();
    // drainTimeout left at its default: a drain would wait it out.
    const db = await createTestClient({ poolSize: 1, debug: true });
    const long = db.all(longQuery(20_000_000));
    long.catch(() => {});
    await waitUntil(
      theQueryIsRunning(db, longQuery(20_000_000)),
      'the query to be running',
    );

    const t0 = performance.now();
    await db.close({ immediate: true });

    await expect(long).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));
    const trace = records[0].log;
    expect(trace).toContain('terminate');
    expect(trace).not.toContain('post:close');
  });

  // Pins the outcome (a cut write is rolled back, the file reopens), on every
  // path: the interruptible ones roll back through SQLite, the other through
  // the journal at the next open.
  it('leaves no trace of a cut write', {
    tags: ['requires:shared-storage'],
  }, async () => {
    const shared = sharedDatabase();
    const db = shared.open({ poolSize: 1, debug: true });
    await db.run('CREATE TABLE t (a)');
    const write = db.run(SLOW_INSERT);
    const outcome = write.then(
      () => 'landed',
      (error: { code?: string }) => error.code ?? 'unknown',
    );
    await waitUntil(aRequestIsInFlight(db), 'the write to be in flight');
    await db.close({ immediate: true });
    const result = await outcome;

    const again = shared.open({ poolSize: 1 });
    const [{ n }] = await again.all<{ n: number }>(
      'SELECT count(*) AS n FROM t',
    );
    await again.close();

    if (!(await exercised(result !== 'landed', 'the write was cut by close()')))
      return;
    expect(result).toBe('CLIENT_CLOSED');
    expect(n).toBe(0);
  });

  // Falsifiable: return `closing` without escalating — the draining close
  // waits the query out (well past the bound, drainTimeout left at 60 s).
  it('makes a draining close immediate', async () => {
    // drainTimeout left at its default: a drain would wait it out.
    const db = await createTestClient({ poolSize: 1, debug: true });
    const long = db.all(longQuery(20_000_000));
    long.catch(() => {});
    await waitUntil(
      theQueryIsRunning(db, longQuery(20_000_000)),
      'the query to be running',
    );

    const draining = db.close();
    const t0 = performance.now();
    const again = db.close({ immediate: true });

    expect(again).toBe(draining);
    await expect(long).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    await again;
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));
  });

  // Falsifiable: merge immediateAbort at the call, in chunk() and stream() —
  // the caller's signal then carries a relay listener that a generator never
  // read never removes.
  it('leaves nothing on the signal of a chunk() or stream() never read', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const controller = new AbortController();
    const added: string[] = [];
    const original = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((
      type: string,
      ...rest: [unknown?, unknown?]
    ) => {
      added.push(type);
      return (original as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof controller.signal.addEventListener;

    db.chunk('SELECT 1', [], { signal: controller.signal });
    db.stream('SELECT 1', [], { signal: controller.signal });

    expect(added).toEqual([]);
  });

  // Falsifiable: assign `closing` after the body's first await again —
  // closeAbort.abort() fires the transaction's signal synchronously, and the
  // close() its listener makes starts a second close with its own promise.
  it('returns the same promise to a close() made from an abort listener', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.run('CREATE TABLE t (a)');
    const entered = Promise.withResolvers<void>();
    let fromListener: Promise<void> | undefined;
    const transaction = db.transaction(async (tx) => {
      tx.signal.addEventListener('abort', () => {
        fromListener = db.close({ immediate: true });
      });
      entered.resolve();
      await new Promise(() => {}); // never settles
    });
    transaction.catch(() => {});
    await entered.promise;

    const first = db.close();
    await first;

    if (
      !(await exercised(
        fromListener !== undefined,
        "the transaction's signal was not aborted by close()",
      ))
    )
      return;
    expect(fromListener).toBe(first);
  });

  // Pins the outcome: a drain-mode call changes nothing of an immediate one.
  it('ignores a draining close() called during an immediate one', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    const long = db.all(longQuery(20_000_000));
    long.catch(() => {});
    await waitUntil(
      theQueryIsRunning(db, longQuery(20_000_000)),
      'the query to be running',
    );

    const t0 = performance.now();
    const immediate = db.close({ immediate: true });
    const draining = db.close();

    expect(draining).toBe(immediate);
    await immediate;
    expect(performance.now() - t0).toBeLessThan(scaled(5_000));
    await expect(long).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
  });
});
