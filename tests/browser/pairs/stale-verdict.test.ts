import { describe, expect, it } from 'vitest';
import { createTestClient, interceptWorkers } from '../helpers';

/**
 * A verdict can depend on the schema: SQLite calls `DROP TRIGGER IF EXISTS`
 * read-only while the trigger is absent. A memoised read verdict that no
 * longer holds must still reach the writer (src/verdicts.ts, `RoutedAsRead`).
 */

type Db = Awaited<ReturnType<typeof createTestClient>>;

const DROP = 'DROP TRIGGER IF EXISTS trg';
const CREATE =
  'CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.a); END';

const CREATE_IF_ABSENT = CREATE.replace('TRIGGER', 'TRIGGER IF NOT EXISTS');

const setUp = async (options: Record<string, unknown> = {}) => {
  const db = await createTestClient({ poolSize: 1, debug: true, ...options });
  await db.run('CREATE TABLE t (a)');
  await db.run('CREATE TABLE log (a)');
  return db;
};

/** The kind of every request that ran `sql`, oldest first. */
const kindsOf = (db: Db, sql: string) =>
  (db.debug?.requests ?? [])
    .filter((r) => r.queries.some((q) => q.sql === sql))
    .map((r) => r.kind);

const triggers = async (db: Db) =>
  (
    await db.all<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger'",
    )
  )[0]?.n;

/** Pushes `DROP` out of the worker's 32-entry statement cache. */
const evict = async (db: Db) => {
  for (let i = 0; i < 40; i++) await db.run(`SELECT ${i} AS evict`);
};

describe('a read verdict the schema made false', () => {
  // Falsifiable: drop the `refuseWrite: 'ROUTED_AS_READ'` of runStatement's
  // read branch in src/client.ts — the DROP runs on the read lease.
  it('run() sends it to the writer once the worker refuses it, and keeps it there', async () => {
    const db = await setUp();
    await db.run(DROP);
    await db.run(CREATE);
    await evict(db);
    // Prepared afresh on the read path: refused before its first step.
    await db.run(DROP);
    expect(await triggers(db)).toBe(0);
    await db.run(DROP);
    expect(kindsOf(db, DROP)).toEqual(['read', 'read', 'write', 'write']);
  });

  // Falsifiable: leave `guardingStep` unset in refuseWrites (src/worker/
  // worker.ts) — the cached statement is re-prepared mid-step into a write.
  it('run() refuses it when its cached statement turns into a write mid-step', async () => {
    const db = await setUp();
    await db.run(DROP);
    await db.run(CREATE);
    // The read path's cached DROP, whose schema the CREATE changed.
    await db.run(DROP);
    expect(await triggers(db)).toBe(0);
    expect(kindsOf(db, DROP)).toEqual(['read', 'read', 'write']);
  });

  // The mirror: CREATE TRIGGER IF NOT EXISTS is read-only while `trg` exists.
  // Falsifiable: as the cached case above.
  it('run() creates the trigger on the writer once a memoised IF NOT EXISTS stopped being a no-op', async () => {
    const db = await setUp();
    await db.run(CREATE);
    await db.run(CREATE_IF_ABSENT);
    expect(await triggers(db)).toBe(1);
    await db.run(DROP);
    await db.run(CREATE_IF_ABSENT);
    expect(await triggers(db)).toBe(1);
    expect(kindsOf(db, CREATE_IF_ABSENT)).toEqual(['read', 'read', 'write']);
  });

  /** stream() over DROP, once its read verdict no longer holds. */
  const streamDrop = async (evicted: boolean) => {
    const db = await setUp();
    await db.run(DROP);
    await db.run(CREATE);
    if (evicted) await evict(db);
    const rows = db.stream(DROP);
    for await (const _ of rows) {
      // No rows.
    }
    expect(await rows.affected).toBe(0);
    expect(await triggers(db)).toBe(0);
    expect(kindsOf(db, DROP)).toEqual(['read', 'read', 'write']);
  };

  // Falsifiable: drop the RoutedAsRead branch of streamWithRetry's catch in
  // src/client.ts — the stream rejects.
  it('stream() sends it to the writer once the worker refuses it', () =>
    streamDrop(true));

  // Falsifiable: as the cached run() case above.
  it('stream() refuses it when its cached statement turns into a write mid-step', () =>
    streamDrop(false));

  // The trigger scenario across two connections. Falsifiable as the first
  // test above.
  it('drops the trigger on the writer, where the other worker sees it gone', {
    tags: ['requires:two-workers'],
  }, async () => {
    const db = await setUp({ poolSize: 2 });
    await db.run(DROP);
    await db.run(CREATE);
    await db.run(DROP);
    expect(kindsOf(db, DROP).at(-1)).toBe('write');
    await db.run('INSERT INTO t VALUES (1)');
    expect(await db.all('SELECT * FROM log')).toEqual([]);
  });

  // In a transaction, a statement with its own signal is savepointed on its
  // verdict: a memoised read would leave the DROP outside the savepoint, and
  // its abandonment would not undo it. Falsifiable: trust a memoised 'read'
  // in kindOnWorker (src/client.ts), or a cached program in verdictOf
  // (src/worker/worker.ts).
  it("asks the transaction's own worker, so an abandoned DROP is undone", async () => {
    const records = interceptWorkers();
    const db = await setUp();
    await db.run(DROP);
    const worker = records[0]?.worker as Worker;
    const abort = new AbortController();
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: unknown, ...rest: unknown[]) => {
      (post as (m: unknown, ...r: unknown[]) => void)(message, ...rest);
      // Once the DROP's query is on its way: the worker runs it, the caller
      // leaves. Not its verdict, which would leave before anything ran; and
      // a microtask later, once the caller races its signal.
      const { type, sql } = message as { type?: string; sql?: string };
      if (type === 'query' && sql === DROP) queueMicrotask(() => abort.abort());
    };
    await db.transaction(async (tx) => {
      await tx.run(CREATE);
      await expect(
        tx.run(DROP, [], { signal: abort.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
    expect(await triggers(db)).toBe(1);
  });
});
