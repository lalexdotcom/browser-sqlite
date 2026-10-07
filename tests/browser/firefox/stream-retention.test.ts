import { describe, expect, it } from '@rstest/core';
import { createTestClient } from '../helpers';

/**
 * Chunks a consumer has taken must be collectable while the query still runs.
 *
 * Firefox only: SpiderMonkey keeps a `Promise.race`'s result alive while any of
 * its inputs is pending, V8 does not. Two such races held every chunk — the
 * pool's wait against the worker-lifetime death promise (`pool.ts`), and the
 * per-chunk race against a query-long abort promise (`queries.ts`,
 * `transaction.ts`), reached with a signal, a timeout, and in any `tx.stream()`.
 *
 * Playwright's Firefox retains what a page consumes with `for await`, so these
 * tests call `next()` by hand. Nothing can force a collection there either, so
 * each test stops mid-query and allocates until tenured witnesses are
 * finalized — proof that a major GC ran — before it counts.
 */

const ROWS = 20_000;
const CHUNK_SIZE = 500;
const TAKEN = 30;
const SQL = 'SELECT id, v FROM t';

const seeded = async () => {
  const db = await createTestClient();
  await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  await db.write(
    'INSERT INTO t (v) WITH RECURSIVE c(x) AS ' +
      `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) ` +
      'SELECT hex(randomblob(256)) FROM c',
  );
  return db;
};

/** Allocates garbage that survives minor GCs until `done()` or 15 s. */
const collectUntil = async (done: () => boolean) => {
  const deadline = performance.now() + 15_000;
  const recent: unknown[][] = [];
  while (!done() && performance.now() < deadline) {
    recent.push(Array.from({ length: 50_000 }, (_, j) => ({ j, s: `x${j}` })));
    if (recent.length > 4) recent.shift();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/**
 * Takes `TAKEN` chunks from `values` — one value in `perChunk` stands for its
 * chunk — then, the query still open, counts how many a major GC finalized.
 */
const freedWhileOpen = async (
  values: AsyncGenerator<object>,
  perChunk: number,
): Promise<number> => {
  let freed = 0;
  let witnessesFreed = 0;
  const chunks = new FinalizationRegistry(() => {
    freed++;
  });
  const witnesses = new FinalizationRegistry(() => {
    witnessesFreed++;
  });
  let held: object[] = [];
  let seen = 0;
  try {
    while (held.length < TAKEN) {
      const next = await values.next();
      if (next.done) throw new Error('the query ended before the pause');
      if (seen++ % perChunk !== 0) continue;
      chunks.register(next.value, 0);
      const witness = { pad: new Array(64).fill(0) };
      witnesses.register(witness, 0);
      held.push(witness);
    }
    held = [];
    await collectUntil(() => witnessesFreed === TAKEN);
    if (witnessesFreed < TAKEN) {
      throw new Error('no major GC within 15 s: the count would mean nothing');
    }
    return freed;
  } finally {
    await values.return(undefined);
  }
};

// The chunk being delivered is still referenced by the generators.
const ALL_BUT_IN_FLIGHT = TAKEN - 2;

describe('consumed chunks are collectable while the query runs', () => {
  it('stream()', async () => {
    const db = await seeded();
    const rows = db.stream(SQL, [], { chunkSize: CHUNK_SIZE });
    expect(await freedWhileOpen(rows, CHUNK_SIZE)).toBeGreaterThanOrEqual(
      ALL_BUT_IN_FLIGHT,
    );
  });

  it('chunk()', async () => {
    const db = await seeded();
    const chunks = db.chunk(SQL, [], { chunkSize: CHUNK_SIZE });
    expect(await freedWhileOpen(chunks, 1)).toBeGreaterThanOrEqual(
      ALL_BUT_IN_FLIGHT,
    );
  });

  it('stream() with a signal', async () => {
    const db = await seeded();
    const controller = new AbortController();
    const rows = db.stream(SQL, [], {
      chunkSize: CHUNK_SIZE,
      signal: controller.signal,
    });
    expect(await freedWhileOpen(rows, CHUNK_SIZE)).toBeGreaterThanOrEqual(
      ALL_BUT_IN_FLIGHT,
    );
  });

  it('stream() with a timeout', async () => {
    const db = await seeded();
    const rows = db.stream(SQL, [], {
      chunkSize: CHUNK_SIZE,
      timeout: 3_600_000,
    });
    expect(await freedWhileOpen(rows, CHUNK_SIZE)).toBeGreaterThanOrEqual(
      ALL_BUT_IN_FLIGHT,
    );
  });

  it('chunk() with a signal', async () => {
    const db = await seeded();
    const controller = new AbortController();
    const chunks = db.chunk(SQL, [], {
      chunkSize: CHUNK_SIZE,
      signal: controller.signal,
    });
    expect(await freedWhileOpen(chunks, 1)).toBeGreaterThanOrEqual(
      ALL_BUT_IN_FLIGHT,
    );
  });

  it('tx.stream()', async () => {
    const db = await seeded();
    const freed = await db.transaction((tx) =>
      freedWhileOpen(tx.stream(SQL, [], { chunkSize: CHUNK_SIZE }), CHUNK_SIZE),
    );
    expect(freed).toBeGreaterThanOrEqual(ALL_BUT_IN_FLIGHT);
  });
});
