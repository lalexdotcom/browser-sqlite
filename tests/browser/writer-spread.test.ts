import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

type TestClient = Awaited<ReturnType<typeof createTestClient>>;

/** Worker indices that served at least one statement matching `pattern`. */
const workersServing = (db: TestClient, pattern: RegExp): Set<number> => {
  const indices = new Set<number>();
  for (const worker of db.debug?.workers ?? [])
    for (const request of worker.requests)
      for (const query of request.queries)
        if (pattern.test(query.sql)) indices.add(worker.index);
  return indices;
};

const WRITE_SQL = /^\s*(CREATE|INSERT|ALTER|DROP|UPDATE|DELETE)/i;

/**
 * Workers initialise in the background and the first query dispatches as soon
 * as ONE of them is ready. Every test below reasons about which worker is free,
 * so the whole pool has to be up before the first statement.
 */
const poolReady = async (db: TestClient, size: number) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const workers = db.debug?.workers ?? [];
    if (
      workers.length === size &&
      workers.every((worker) => worker.status === 'READY')
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('pool never reached READY');
};

describe('writer spread', () => {
  // Falsifiable: delete the `currentWriterIndex = -1` release in handOver()
  // (src/scheduler.ts) and every write queues behind the first designated
  // worker — the set collapses to one index and this goes red.
  it('sends a write to a free worker while a read holds the preferred one', async () => {
    const db = await createTestClient({ debug: true });
    await poolReady(db, 2);

    await db.write('CREATE TABLE spread (id INTEGER PRIMARY KEY, v TEXT)');
    await db.write("INSERT INTO spread (v) VALUES ('a')");

    // Hold a read open on the worker every acquisition prefers (lowest index).
    const held = db.stream('SELECT * FROM spread');
    expect((await held.next()).done).toBe(false);

    // DDL first: a stale page map used to make this fail at `prepare` with
    // `no such table`, which is why stickiness existed at all.
    await db.write('ALTER TABLE spread ADD COLUMN extra TEXT');
    await db.write("INSERT INTO spread (v, extra) VALUES ('b', 'x')");

    await held.return(undefined);

    const rows = await db.read<{ v: string; extra: string | null }>(
      'SELECT v, extra FROM spread ORDER BY id',
    );
    expect(rows.map((row) => row.v)).toEqual(['a', 'b']);
    expect(rows[1]?.extra).toBe('x');

    expect(workersServing(db, WRITE_SQL).size).toBe(2);

    await db.close();
  });

  // NOT a stickiness detector — it passes either way, and says so on purpose.
  // It is the regression guard for what relaxing the designation risks: writes
  // spread over connections while other connections read, which is where a
  // missing barrier surfaces as `no such table` or a stale row set.
  it('keeps results correct under writes and reads issued together', async () => {
    const db = await createTestClient({ debug: true });
    await poolReady(db, 2);

    await db.write('CREATE TABLE mixed (id INTEGER PRIMARY KEY, v INTEGER)');

    const pending: Promise<unknown>[] = [];
    for (let round = 0; round < 12; round += 1) {
      pending.push(db.write('INSERT INTO mixed (v) VALUES (?)', [round]));
      pending.push(db.read('SELECT count(*) AS n FROM mixed'));
    }
    await Promise.all(pending);

    // DDL against the same table the reads above touched, then a read that can
    // only succeed on a connection that absorbed it.
    await db.write('ALTER TABLE mixed ADD COLUMN tag TEXT');
    await db.write("UPDATE mixed SET tag = 'done'");

    const rows = await db.read<{ n: number; tagged: number }>(
      "SELECT count(*) AS n, sum(tag = 'done') AS tagged FROM mixed",
    );
    expect(rows[0]?.n).toBe(12);
    expect(rows[0]?.tagged).toBe(12);

    await db.close();
  });
});
