import { sql } from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import type { PoolWorker } from '../../../src/pool';
import {
  createTestClient,
  interceptWorkers,
  killSilently,
  scaled,
  sleep,
  type WorkerRecord,
} from '../helpers';

/**
 * `run()` and `all()` take any single statement: a worker's verdict, memoised
 * per client, sends it to the read path or to the write path.
 */

type TestClient = Awaited<ReturnType<typeof createTestClient>>;

/** The slot a recorded worker fills. */
const slotOf = (record: WorkerRecord) =>
  (record.worker as unknown as PoolWorker).index;

/** Verdicts posted to every worker so far. */
const verdictsPosted = (records: WorkerRecord[]) =>
  records.flatMap((r) => r.posted).filter((t) => t === 'verdict').length;

const setUp = async (options: Record<string, unknown> = {}) => {
  const records = interceptWorkers();
  const db = await createTestClient({ poolSize: 1, ...options });
  await db.write('CREATE TABLE t (a, b)');
  return { db, records };
};

/** Holds a worker with a read left open after its first row. */
const holdWorker = async (db: TestClient) => {
  const held = db.stream('SELECT 1 AS x UNION ALL SELECT 2', [], {
    chunkSize: 1,
  });
  expect((await held.next()).done).toBe(false);
  return held;
};

/**
 * Runs `act` on the worker the first verdict is posted to, before or after the
 * post. Returns a getter for that worker.
 */
const onFirstVerdict = (
  records: WorkerRecord[],
  when: 'before' | 'after',
  act: (worker: Worker) => void,
) => {
  let hit: Worker | undefined;
  for (const record of records) {
    const target = record.worker;
    const post = target.postMessage.bind(target) as (
      message: unknown,
      ...rest: unknown[]
    ) => void;
    target.postMessage = (message: unknown, ...rest: unknown[]) => {
      const first = (message as { type?: string }).type === 'verdict' && !hit;
      if (first) hit = target;
      if (first && when === 'before') act(target);
      post(message, ...rest);
      if (first && when === 'after') act(target);
    };
  }
  return () => hit;
};

/** Every worker READY: the tests below reason about which one is free. */
const poolReady = async (db: TestClient, size: number) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const workers = db.debug?.workers ?? [];
    if (
      workers.length === size &&
      workers.every((worker) => worker.status === 'READY')
    )
      return;
    await sleep(10);
  }
  throw new Error('pool never reached READY');
};

describe('run() and all()', () => {
  // Falsifiable: route every verdict to the read path in run().
  it('runs an INSERT: no rows, one affected', async () => {
    const { db } = await setUp();
    expect(await db.run('INSERT INTO t VALUES (1, 1)')).toEqual({
      rows: [],
      affected: 1,
    });
  });

  // Falsifiable: push no rows in runWorker (src/queries.ts).
  it("returns an INSERT's RETURNING rows", async () => {
    const { db } = await setUp();
    expect(await db.run('INSERT INTO t VALUES (1, 1) RETURNING a')).toEqual({
      rows: [{ a: 1 }],
      affected: 1,
    });
  });

  // Falsifiable: route every verdict to the write path in run() — `affected`
  // stays 0, so the debug tree's request kind is what tells.
  it('runs a SELECT on the read path: its rows, none affected', async () => {
    const { db } = await setUp({ debug: true });
    await db.run('INSERT INTO t VALUES (1, 1)');
    expect(await db.run('SELECT a FROM t')).toEqual({
      rows: [{ a: 1 }],
      affected: 0,
    });
    const request = db.debug?.requests.find((r) =>
      r.queries.some((q) => q.sql === 'SELECT a FROM t'),
    );
    expect(request?.kind).toBe('read');
  });

  // Falsifiable: return the whole result from all().
  it('all() returns the rows of a SELECT', async () => {
    const { db } = await setUp();
    await db.run('INSERT INTO t VALUES (1, 1)');
    expect(await db.all('SELECT a FROM t')).toEqual([{ a: 1 }]);
  });

  // Falsifiable: push no rows in runWorker (src/queries.ts).
  it('all() returns the rows of a DELETE … RETURNING, and deletes', async () => {
    const { db } = await setUp();
    await db.run('INSERT INTO t VALUES (1, 1)');
    expect(await db.all('DELETE FROM t RETURNING a')).toEqual([{ a: 1 }]);
    expect(await db.all('SELECT a FROM t')).toEqual([]);
  });

  // Falsifiable: treat 'refused' as 'write' in kindFor — the worker still
  // refuses, but from the writer's queue.
  it('refuses two statements with MULTIPLE_STATEMENTS, without queueing them', async () => {
    const { db } = await setUp({ debug: true });
    const before = db.debug?.requests.length;
    await expect(db.run('SELECT 1; SELECT 2')).rejects.toMatchObject({
      code: 'MULTIPLE_STATEMENTS',
    });
    expect(db.debug?.requests.length).toBe(before);
  });

  // Falsifiable: answer 'write' when the second prepare fails in askVerdict —
  // the statement still fails, but from the writer's queue.
  it('rejects a statement that does not prepare with STATEMENT_FAILED, without queueing it', async () => {
    const { db } = await setUp({ debug: true });
    const before = db.debug?.requests.length;
    await expect(db.run('SELECT * FROM nope')).rejects.toMatchObject({
      code: 'STATEMENT_FAILED',
      sqliteCode: 1,
    });
    expect(db.debug?.requests.length).toBe(before);
  });

  // Falsifiable: memoise nothing in kindFor (each call asks).
  it('asks one verdict for ten concurrent calls of one statement', async () => {
    const { db, records } = await setUp();
    const before = verdictsPosted(records);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.run('SELECT 7 AS x')),
    );
    expect(results).toEqual(
      Array.from({ length: 10 }, () => ({ rows: [{ x: 7 }], affected: 0 })),
    );
    expect(verdictsPosted(records) - before).toBe(1);
  });

  // Falsifiable: memoise nothing in kindFor.
  it('asks one verdict for a statement built by sql, run twice', async () => {
    const { db, records } = await setUp();
    const before = verdictsPosted(records);
    expect(await db.run(sql`SELECT ${1} AS x`)).toEqual({
      rows: [{ x: 1 }],
      affected: 0,
    });
    expect(await db.run(sql`SELECT ${1} AS x`)).toEqual({
      rows: [{ x: 1 }],
      affected: 0,
    });
    expect(verdictsPosted(records) - before).toBe(1);
  });

  // Falsifiable: acquire the verdict's lease without the signal — the
  // abandoned request stays queued, and is served a second verdict.
  it('rejects with the reason of a signal aborted while it waits for a verdict, and leaves nothing queued', async () => {
    const { db, records } = await setUp();
    const held = await holdWorker(db);
    const before = verdictsPosted(records);
    const controller = new AbortController();
    const reason = new Error('given up');
    const waiting = db.run('SELECT 5 AS x', [], { signal: controller.signal });
    await sleep(0);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    await held.return(undefined);
    expect(await db.run('SELECT 6 AS x')).toEqual({
      rows: [{ x: 6 }],
      affected: 0,
    });
    expect(verdictsPosted(records) - before).toBe(1);
  });

  // Falsifiable: leave verdict waiters out of the scheduler's shutdown.
  it('rejects a call waiting for a verdict with CLIENT_CLOSED on close()', async () => {
    const { db } = await setUp();
    const held = await holdWorker(db);
    const waiting = db.run('SELECT 8 AS x');
    await sleep(0);
    const closing = db.close();
    await expect(waiting).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    await held.return(undefined);
    await closing;
  });

  // Falsifiable: throw `timeout`'s deadline away until the verdict is in.
  it('counts the timeout from the call, across the verdict wait', async () => {
    const { db } = await setUp();
    const held = await holdWorker(db);
    await expect(
      db.run('SELECT 9 AS x', [], { timeout: 50 }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    await held.return(undefined);
  });
});

describe('run() and all() on two workers', {
  tags: ['requires:two-workers'],
}, () => {
  // Falsifiable: resolve run()'s write path before the write has run (fire
  // runOnWriter without awaiting it). Dropping the barrier or afterWrite does
  // not redden it on any pair (measured): SQLite's own schema and change
  // checks already refresh the other connection here.
  it('reads its own write on the worker that did not write', async () => {
    const { db } = await setUp({ poolSize: 2, debug: true });
    await poolReady(db, 2);
    for (let i = 0; i < 4; i++) {
      await db.run(`ALTER TABLE t ADD COLUMN c${i}`);
      await db.run(`INSERT INTO t (c${i}) VALUES (?)`, [i]);
      // A read prefers the worker that wrote last: hold it, so the verdict
      // and the read go to the other one, whose schema is one change behind.
      const held = await holdWorker(db);
      expect(
        await db.all(`SELECT c${i} AS c FROM t WHERE c${i} IS NOT NULL`),
      ).toEqual([{ c: i }]);
      await held.return(undefined);
    }
  });

  // Falsifiable: keep the memo entry when its last caller leaves (kindFor's
  // finally) — the second call joins the verdict that never answers.
  it('times out on a verdict worker killed silently, and the next call goes elsewhere', async () => {
    const { db, records } = await setUp({
      poolSize: 2,
      drainTimeout: 500,
      debug: true,
    });
    await poolReady(db, 2);
    // Killed before the verdict is posted: it can never answer, and nothing
    // detects a silent death (B2) — the caller's timeout bounds the call.
    const killed = onFirstVerdict(records, 'before', killSilently);
    await expect(
      db.run('SELECT 4 AS x', [], { timeout: scaled(300) }),
    ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(killed()).toBeDefined();
    expect(
      await db.run('SELECT 4 AS x', [], { timeout: scaled(5_000) }),
    ).toEqual({ rows: [{ x: 4 }], affected: 0 });
  });

  // Falsifiable: surface the first death in askVerdict (`deaths > 0`).
  it('asks once more on another worker when its verdict worker dies', async () => {
    const { db, records } = await setUp({ poolSize: 2, debug: true });
    await poolReady(db, 2);
    // Posted, then the worker reports an error: the pool's death path.
    const crashed = onFirstVerdict(records, 'after', (worker) =>
      worker.dispatchEvent(new ErrorEvent('error', { message: 'simulated' })),
    );
    expect(await db.run('SELECT 5 AS x')).toEqual({
      rows: [{ x: 5 }],
      affected: 0,
    });
    expect(crashed()).toBeDefined();
    expect(verdictsPosted(records)).toBe(2);
  });

  // Falsifiable: drop the offer() call from transaction.ts — the verdict
  // waits for the held read or the transaction's end.
  it("takes its verdict from a transaction's worker between two statements", async () => {
    const { db, records } = await setUp({ poolSize: 2, debug: true });
    await poolReady(db, 2);
    const held = await holdWorker(db);
    // The held stream asked its own verdict; only those after it count.
    const mark = new Map(records.map((r) => [r, r.posted.length]));
    let running: Promise<unknown> | undefined;
    let txWorker: number | undefined;
    await db.transaction(async (tx) => {
      running = db.run('SELECT 3 AS x');
      await tx.write('INSERT INTO t VALUES (1, 1)');
      txWorker = db.debug?.requests.find((r) =>
        r.queries.some((q) => q.sql === 'INSERT INTO t VALUES (1, 1)'),
      )?.worker;
      const posted = () =>
        records.some(
          (r) => slotOf(r) === txWorker && r.posted.includes('verdict'),
        );
      for (let i = 0; i < 500 && !posted(); i++) await sleep(5);
      expect(posted()).toBe(true);
      await tx.write('INSERT INTO t VALUES (2, 2)');
    });
    expect(txWorker).toBeDefined();
    const others = records.filter((r) => slotOf(r) !== txWorker);
    expect(
      others
        .flatMap((r) => r.posted.slice(mark.get(r) ?? 0))
        .filter((t) => t === 'verdict').length,
    ).toBe(0);
    await held.return(undefined);
    expect(await running).toEqual({ rows: [{ x: 3 }], affected: 0 });
    expect(await db.all('SELECT a FROM t ORDER BY a')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });
});
