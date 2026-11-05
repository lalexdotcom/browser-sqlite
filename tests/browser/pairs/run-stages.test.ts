import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  theQueryHasEnded,
  theQueryIsComputing,
  waitUntil,
} from '../helpers';

/** Where a running query is (`workers[i].run`) and where its time went (`stages`). */

type TestClient = Awaited<ReturnType<typeof createTestClient>>;

const queriesOf = (db: TestClient, sql: string) =>
  (db.debug?.requests ?? []).flatMap((request) =>
    request.queries.filter((query) => query.sql === sql),
  );

// A thousand rows, one per chunk with `chunkSize: 1`: the credit window runs out.
const STREAM =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000) SELECT x FROM c';

describe('the run stages of a debug client', () => {
  it('a first statement is prepared then stepped; the same one again is only stepped', async () => {
    // first(): all() and run() prepare the statement for their verdict, so the
    // query that follows would find it cached. WHERE 0: no row, so the reply
    // that counts is the last.
    const SQL = 'SELECT 1 AS a WHERE 0';
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      await db.first(SQL);
      await db.first(SQL);
      const [first, second] = queriesOf(db, SQL);
      expect(Object.keys(first?.stages ?? {})).toEqual(
        expect.arrayContaining(['preparing', 'stepping']),
      );
      expect(Object.keys(second?.stages ?? {})).toContain('stepping');
      expect(Object.keys(second?.stages ?? {})).not.toContain('preparing');
      for (const query of [first, second]) {
        for (const value of Object.values(query?.stages ?? {})) {
          expect(typeof value).toBe('number');
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
      expect(db.debug?.workers[0]?.run).toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it('a long step is computing, live and in its record', {
    tags: ['requires:interruptible'],
  }, async () => {
    const sql = longQuery(20_000_000);
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      const abort = new AbortController();
      const pending = db.all(sql, [], { signal: abort.signal });
      pending.catch(() => {});
      await waitUntil(
        theQueryIsComputing(db, sql),
        'the query to be computing',
      );
      abort.abort();
      await expect(pending).rejects.toBeDefined();
      // A stage is recorded when it closes, with the worker's reply.
      await waitUntil(
        theQueryHasEnded(db, sql),
        'the query to be reported ended',
      );
      expect(queriesOf(db, sql).at(-1)?.stages?.computing).toBeDefined();
      await waitUntil(
        () => db.debug?.workers[0]?.run === undefined,
        'the worker to leave its run stage',
      );
    } finally {
      await db.close();
    }
  });

  it('a stream with no credit left is awaiting credit', async () => {
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      for await (const _ of db.chunk(STREAM, [], { chunkSize: 1 })) {
        await waitUntil(
          () => db.debug?.workers[0]?.run === 'awaiting-credit',
          'the worker to wait for credit',
        );
        break;
      }
      // The stage the stop cut is recorded with the worker's reply.
      await waitUntil(
        theQueryHasEnded(db, STREAM),
        'the query to be reported ended',
      );
      expect(Object.keys(queriesOf(db, STREAM).at(-1)?.stages ?? {})).toContain(
        'awaiting-credit',
      );
    } finally {
      await db.close();
    }
  });

  it('a first read is classified in a verdict request of its own', async () => {
    const SQL = 'SELECT 41 + 1 AS v';
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      await db.all(SQL);
      const requests = db.debug?.requests ?? [];
      const verdictAt = requests.findIndex(
        (request) => request.kind === 'verdict',
      );
      const readAt = requests.findIndex(
        (request) =>
          request.kind === 'read' &&
          request.queries.some((query) => query.sql === SQL),
      );
      expect(verdictAt).toBeGreaterThanOrEqual(0);
      expect(readAt).toBeGreaterThan(verdictAt);
      const verdict = requests[verdictAt];
      const read = requests[readAt];
      expect(verdict?.queries.map((query) => query.sql)).toEqual([SQL]);
      expect(verdict?.queries[0]?.internal).toBe(true);
      expect(Object.keys(verdict?.queries[0]?.stages ?? {})).toContain(
        'preparing',
      );
      const own = read?.queries.find((query) => query.sql === SQL);
      expect(Object.keys(own?.stages ?? {})).not.toContain('preparing');
      expect(verdict?.endTime).toBeDefined();
      expect(verdict?.endTime ?? Infinity).toBeLessThanOrEqual(
        read?.acquireTime ?? -Infinity,
      );
    } finally {
      await db.close();
    }
  });

  it("a statement given its own signal in a transaction is classified in the transaction's request", async () => {
    const SQL = 'INSERT INTO t VALUES (7)';
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      await db.run('CREATE TABLE t (a)');
      await db.transaction(async (tx) => {
        await tx.run(SQL, [], { signal: new AbortController().signal });
      });
      const requests = db.debug?.requests ?? [];
      expect(
        requests.some(
          (request) =>
            request.kind === 'verdict' &&
            request.queries.some((query) => query.sql === SQL),
        ),
      ).toBe(false);
      const transaction = requests.find((request) =>
        request.queries.some((query) => query.sql === SQL),
      );
      const matching = (transaction?.queries ?? []).filter(
        (query) => query.sql === SQL,
      );
      expect(matching.length).toBeGreaterThanOrEqual(2);
      expect(matching[0]?.internal).toBe(true);
      expect(Object.keys(matching[0]?.stages ?? {})).toContain('preparing');
      expect(matching.at(-1)?.internal).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("a verdict's query counts the statement it compiled", async () => {
    const SQL = 'SELECT 7 + 1 AS v';
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      await db.all(SQL);
      const verdict = (db.debug?.requests ?? []).find(
        (request) => request.kind === 'verdict',
      );
      expect(verdict?.queries[0]?.prepared).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("a verdict served from the worker's statement cache compiles nothing", async () => {
    // first() prepares SQL and caches it; all() then asks a verdict.
    const SQL = 'SELECT 9 + 1 AS v';
    const db = await createTestClient({ debug: true, poolSize: 1 });
    try {
      await db.first(SQL);
      await db.all(SQL);
      const verdict = (db.debug?.requests ?? []).find(
        (request) => request.kind === 'verdict',
      );
      expect(verdict?.queries[0]?.sql).toBe(SQL);
      expect(verdict?.queries[0]?.prepared).toBe(0);
      expect(Object.keys(verdict?.queries[0]?.stages ?? {})).not.toContain(
        'preparing',
      );
    } finally {
      await db.close();
    }
  });

  it("a verdict whose worker dies ends its query failed, and the retry's is served", async () => {
    const SQL = 'SELECT 5 AS x';
    const records = interceptWorkers();
    const db = await createTestClient({ debug: true, poolSize: 2 });
    try {
      await waitUntil(() => {
        const workers = db.debug?.workers ?? [];
        return (
          workers.length === 2 &&
          workers.every((worker) => worker.status === 'READY')
        );
      }, 'every worker READY');
      // The first verdict is posted, then its worker reports an error: the
      // pool's death path, which fails the verdict's debug query.
      let crashed = false;
      for (const { worker } of records) {
        const post = worker.postMessage.bind(worker) as (
          message: unknown,
          ...rest: unknown[]
        ) => void;
        worker.postMessage = (message: unknown, ...rest: unknown[]) => {
          const first =
            (message as { type?: string }).type === 'verdict' && !crashed;
          if (first) crashed = true;
          post(message, ...rest);
          if (first)
            worker.dispatchEvent(new ErrorEvent('error', { message: 'x' }));
        };
      }
      await db.run(SQL);
      const verdicts = (db.debug?.requests ?? []).filter(
        (request) => request.kind === 'verdict',
      );
      expect(crashed).toBe(true);
      const [dead, served] = verdicts.map((request) => request.queries[0]);
      expect(dead?.error).toBeDefined();
      expect(dead?.endTime).toBeDefined();
      expect(served?.error).toBeUndefined();
      expect(served?.endTime).toBeDefined();
    } finally {
      await db.close();
    }
  });

  it('a client without debug receives no run stage', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.all('SELECT 1');
      for await (const _ of db.chunk(STREAM, [], { chunkSize: 1 })) {
        // Read to the end.
      }
      expect(records[0]?.received).not.toContain('run');
    } finally {
      await db.close();
    }
  });
});
