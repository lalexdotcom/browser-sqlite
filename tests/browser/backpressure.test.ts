import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

/** 5000 rows, one column — enough chunks that running ahead is obvious. */
const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  await db.write(
    `INSERT INTO t(id) SELECT x FROM (
       WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000)
       SELECT x FROM c)`,
  );
};

const chunksPosted = (record: { received: string[] }) =>
  record.received.filter((type) => type === 'chunk').length;

describe('back-pressure', () => {
  // Falsifiable: grant the credit when the chunk message arrives instead of
  // after the yield, or drop the credit wait in the worker, and the worker
  // posts all 5000 chunks while this consumer sleeps. Pins spec §3.3.
  it('does not let the worker run ahead of a slow consumer', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await seed(db);

    let seen = 0;
    for await (const _rows of db.chunk('SELECT id FROM t', [], {
      chunkSize: 1,
    })) {
      seen += 1;
      if (seen === 5) {
        await sleep(300);
        break;
      }
    }

    // Five consumed, plus at most one window of look-ahead.
    expect(chunksPosted(records[0])).toBeLessThanOrEqual(7);
  });

  // Falsifiable: remove the `stop` message from pool.ts's drain, or the wake
  // from the gate's stop(), and the worker stays parked on a credit until
  // drainTimeout, is presumed dead, and is replaced. Pins spec §5.1.
  it('does not restart the worker when a stream is abandoned', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 1000 });
    await seed(db);

    for await (const _rows of db.chunk('SELECT id FROM t', [], {
      chunkSize: 1,
    })) {
      break;
    }

    await sleep(1500); // past drainTimeout, plus a replacement's boot
    expect(records.length).toBe(1);

    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
  });

  // Falsifiable: remove the credit wait from worker.ts (drop the gate.take
  // call), and the worker runs ahead unconstrained. Then verify the
  // abort-and-drain path still works when the worker happens to be parked on
  // a credit rather than inside sqlite.step(). The credit wait is a new
  // suspension point; this test confirms it does not bypass the wave-2
  // abort+drain machinery. Silent death without an abort is not detectable
  // by design (B2); the caller must abort, as it does here.
  it('reclaims a worker killed while it is parked on a credit', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await seed(db);

    const streaming = db.chunk('SELECT id FROM t', [], {
      chunkSize: 1,
      signal: AbortSignal.timeout(200),
    });
    const consuming = (async () => {
      for await (const _rows of streaming) {
        await sleep(50); // long enough that the worker is waiting, not working
      }
    })();

    await sleep(100);
    records[0].worker.terminate(); // silent death: no event of any kind

    await expect(consuming).rejects.toThrow();
    await sleep(1500); // past drainTimeout (500 ms), plus a replacement's boot
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2); // the dead one was replaced
  });

  it('still delivers every row when the consumer keeps up', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await seed(db);
    const rows = await db.read<{ id: number }>('SELECT id FROM t');
    expect(rows).toHaveLength(5000);
    expect(rows[4999]?.id).toBe(5000);
  });
});

describe('first()', () => {
  // Falsifiable two ways. Drop `credits: 1` and the worker produces a second
  // row nobody asked for, so chunksPosted becomes 2. Break the stop-wakes-the
  // -wait path and each call parks its worker until drainTimeout, so it is
  // replaced and records.length grows. Pins spec §4.1 and §5.1.
  it('costs exactly one row, and never restarts its worker', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 1000 });
    await seed(db);

    for (let call = 0; call < 10; call += 1) {
      const row = await db.first<{ id: number }>('SELECT id FROM t');
      expect(row?.id).toBe(1);
    }

    expect(chunksPosted(records[0])).toBe(10);
    await sleep(1500);
    expect(records.length).toBe(1);
  });
});

describe('close() during a query', () => {
  // Falsifiable: remove the `closing` check in the worker's query handler —
  // the in-flight stream resolves with a partial result instead of rejecting,
  // and the `toBe('rejected')` assertion below is what catches it.
  // Pins spec §5.3.
  it('stops the query first, then closes', async () => {
    const db = await createTestClient({ poolSize: 1, drainTimeout: 300 });
    await seed(db);

    const streaming = (async () => {
      const collected: number[] = [];
      for await (const rows of db.chunk<{ id: number }>(
        'SELECT id FROM t',
        [],
        { chunkSize: 1 },
      )) {
        collected.push(rows[0]?.id ?? -1);
        await sleep(5);
      }
      return collected;
    })().catch(() => 'rejected' as const);

    await sleep(100);
    const started = performance.now();
    await db.close();
    // Bounded by drainTimeout (300 ms); with a slow consumer the drain runs to
    // drainTimeout — that is the wave-2 contract. We assert well below 3 s.
    expect(performance.now() - started).toBeLessThan(3000);

    expect(await streaming).toBe('rejected');
    await expect(db.read('SELECT 1 AS n')).rejects.toThrow();
  });
});
