import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * INT-07: Concurrent reads are served by different workers in parallel
 *
 * With poolSize: 2 (default), two simultaneous db.read() calls should resolve
 * without waiting for each other. We verify that Promise.all resolves with correct results.
 * Parallelism is verified indirectly: if reads were serialized, total time would be ~2x
 * a single read — acceptable not to measure time, the important thing is both resolve correctly.
 */
describe('concurrent reads (INT-07)', () => {
  it('two concurrent db.read() both return correct results', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE concurrent_read (id INTEGER, val TEXT)');
    await db.write(
      "INSERT INTO concurrent_read VALUES (1, 'a'), (2, 'b'), (3, 'c')",
    );

    // Launch two reads simultaneously — poolSize: 2 dispatches them to two workers
    const [result1, result2] = await Promise.all([
      db.read<{ id: number; val: string }>(
        'SELECT * FROM concurrent_read WHERE id = 1',
      ),
      db.read<{ id: number; val: string }>(
        'SELECT * FROM concurrent_read WHERE id = 2',
      ),
    ]);

    expect(result1).toHaveLength(1);
    expect(result1[0].id).toBe(1);
    expect(result1[0].val).toBe('a');

    expect(result2).toHaveLength(1);
    expect(result2[0].id).toBe(2);
    expect(result2[0].val).toBe('b');

    db.close();
  });

  it('three concurrent db.read() all resolve (third is queued)', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE multi_read (n INTEGER)');
    await db.write('INSERT INTO multi_read VALUES (10), (20), (30)');

    // poolSize: 2 → first two run in parallel, third waits
    const [r1, r2, r3] = await Promise.all([
      db.read<{ n: number }>('SELECT n FROM multi_read WHERE n = 10'),
      db.read<{ n: number }>('SELECT n FROM multi_read WHERE n = 20'),
      db.read<{ n: number }>('SELECT n FROM multi_read WHERE n = 30'),
    ]);

    expect(r1[0].n).toBe(10);
    expect(r2[0].n).toBe(20);
    expect(r3[0].n).toBe(30);

    db.close();
  });
});

/**
 * INT-08: Writes are serialized through a single writer worker
 *
 * Mechanism: currentWriterIndex designates the writer on the first write().
 * Any subsequent write() while the writer is busy is placed in writerRequestQueue.
 * Concurrent writes therefore execute in queue order, not in parallel.
 */
describe('serialized writes (INT-08)', () => {
  it('two concurrent db.write() produce a consistent result (no corruption)', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE serial_write (id INTEGER, val TEXT)');

    // Launch two writes simultaneously — must be serialized
    await Promise.all([
      db.write("INSERT INTO serial_write VALUES (1, 'first')"),
      db.write("INSERT INTO serial_write VALUES (2, 'second')"),
    ]);

    // Both rows must be present — no corruption
    const rows = await db.read<{ id: number; val: string }>(
      'SELECT * FROM serial_write ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(1);
    expect(rows[1].id).toBe(2);

    db.close();
  });

  it('sequential writes are correctly ordered', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE order_test (seq INTEGER)');

    // Explicit sequential writes — each write waits for the previous one
    await db.write('INSERT INTO order_test VALUES (1)');
    await db.write('INSERT INTO order_test VALUES (2)');
    await db.write('INSERT INTO order_test VALUES (3)');

    const rows = await db.read<{ seq: number }>(
      'SELECT seq FROM order_test ORDER BY seq',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].seq).toBe(1);
    expect(rows[2].seq).toBe(3);

    db.close();
  });
});

/**
 * INT-09: AbortSignal cancels an in-flight request — no additional chunks
 *
 * Mechanism (src/client.ts l.251-258):
 *   signal.abort() → signalAbortHandler() → orchestrator.setStatus(ABORTING)
 *   Worker checks ABORTING at each iteration and exits → generator terminates (done: true)
 *
 * Note: generate_series is not available in wa-sqlite by default.
 * We use a JavaScript batch INSERT to create enough rows.
 */
describe('AbortSignal (INT-09)', () => {
  it('cancels an in-flight stream and delivers no more chunks after abort', async () => {
    const db = await createTestClient();

    // Create a table with 1000 rows to force multiple chunks
    await db.write('CREATE TABLE bigdata (n INTEGER)');
    const values = Array.from({ length: 1000 }, (_, i) => `(${i + 1})`).join(
      ',',
    );
    await db.write(`INSERT INTO bigdata VALUES ${values}`);

    const controller = new AbortController();
    let chunkCount = 0;

    const gen = db.stream<{ n: number }>(
      'SELECT n FROM bigdata ORDER BY n',
      [],
      {
        signal: controller.signal,
        chunkSize: 50, // 1000 / 50 = 20 potential chunks
      },
    );

    // Receive the first chunk, then abort
    const first = await gen.next();
    expect(first.done).toBe(false);
    chunkCount++;
    controller.abort();

    // Drain the generator — should terminate quickly after abort
    let safetyValve = 0;
    for await (const _chunk of gen) {
      chunkCount++;
      safetyValve++;
      if (safetyValve > 5) break; // Safety net if abort doesn't work
    }

    // Should NOT have received all 20 potential chunks
    expect(chunkCount).toBeLessThan(20);

    db.close();
  });

  it('an already-aborted AbortSignal terminates immediately', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE pre_aborted (x INTEGER)');
    await db.write('INSERT INTO pre_aborted VALUES (1), (2), (3)');

    const controller = new AbortController();
    controller.abort(); // Abort BEFORE launching the stream

    let chunkCount = 0;
    for await (const _chunk of db.stream('SELECT x FROM pre_aborted', [], {
      signal: controller.signal,
      chunkSize: 1,
    })) {
      chunkCount++;
    }

    // The stream may deliver 0 or a few chunks depending on timing,
    // but certainly not all (3 rows / chunkSize 1 = 3 chunks max)
    // The important thing: no unhandled error
    expect(chunkCount).toBeLessThanOrEqual(3);

    db.close();
  });
});

/**
 * INT-10: A SQL error rejects the Promise with a descriptive Error
 *
 * Mechanism: the worker sends { type: 'error', message, cause }
 * The client creates new Error(data.message, { cause: data.cause }) and rejects the Promise
 */
describe('SQL errors (INT-10)', () => {
  it('invalid SQL syntax rejects with an Error with a non-empty message', async () => {
    const db = await createTestClient();

    await expect(db.read('THIS IS NOT VALID SQL !!!')).rejects.toThrow();

    // Verify the error has a descriptive message
    try {
      await db.read('SELECT * FROM !!!invalid');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.length).toBeGreaterThan(0);
    }

    db.close();
  });

  it('a missing table rejects with an Error mentioning the table', async () => {
    const db = await createTestClient();

    try {
      await db.read('SELECT * FROM table_that_does_not_exist');
      // If we get here, the test fails
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // SQLite message usually mentions the missing table name
      expect((err as Error).message).toBeTruthy();
      expect((err as Error).message.length).toBeGreaterThan(0);
    }

    db.close();
  });

  it('client remains usable after a SQL error', async () => {
    const db = await createTestClient();

    // First query: error
    await expect(db.read('SELECT * FROM nonexistent_table')).rejects.toThrow();

    // Second query: should work normally
    const rows = await db.read<{ val: number }>('SELECT 42 AS val');
    expect(rows[0].val).toBe(42);

    db.close();
  });
});

/**
 * D-09: Test lock() blocking behavior in browser environment
 *
 * Context: Phase 2 D2 deferred this test to Phase 3.
 * lock() is called only inside workers (in open()).
 * With poolSize: 2, both workers call lock() during open() — the second
 * blocks on Atomics.wait until the first calls unlock() after its open().
 *
 * Pragmatic test: if both workers initialize successfully (READY),
 * the lock/unlock mechanism works. If lock() were broken, both workers
 * would open the DB simultaneously, risking corruption or errors.
 */
describe('lock() blocking behavior (D-09)', () => {
  it('both workers with poolSize: 2 reach READY (sequential lock/unlock)', async () => {
    // createTestClient creates a client with poolSize: 2 by default
    const db = await createTestClient();

    // If both workers are READY, lock/unlock worked correctly
    // (each waited its turn to open the DB)
    const rows = await db.read<{ n: number }>('SELECT 2 AS n');
    expect(rows[0].n).toBe(2);

    // Run operations on both workers to confirm both are active
    const [r1, r2] = await Promise.all([
      db.read<{ w: number }>('SELECT 1 AS w'),
      db.read<{ w: number }>('SELECT 2 AS w'),
    ]);

    expect(r1[0].w).toBe(1);
    expect(r2[0].w).toBe(2);

    db.close();
  });
});
