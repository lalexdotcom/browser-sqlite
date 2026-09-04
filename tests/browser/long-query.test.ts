import { describe, expect, it } from '@rstest/core';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  sleep,
} from './helpers';

describe('a long single step', () => {
  // Falsifiable: bound the query itself with any timer and this fails.
  it('runs to completion untouched', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const rows = await db.read<{ n: number }>(longQuery(2_000_000));
    expect(rows[0]?.n).toBe(2_000_000);
  });

  // Falsifiable: drop the abort from the race in chunk() and go back to testing
  // `aborted` after the await — the rejection then waits for the sort to finish
  // and this exceeds its budget.
  it('gives the caller back control at the moment the signal fires', async () => {
    const db = await createTestClient({ poolSize: 2 });
    const started = performance.now();
    await expect(
      db.read(longQuery(20_000_000), [], {
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Falsifiable: remove the `interrupt()` call in chunk()'s finally — without
  // it the worker transitions RUNNING → READY without passing through ABORTING,
  // so the ABORTING status check fails.
  it('does not terminate the worker it abandoned', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({
      poolSize: 2,
      drainTimeout: 60_000,
      debug: true,
    });
    await db.write('CREATE TABLE t (a)');

    await expect(
      db.read(longQuery(20_000_000), [], { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();

    // At least two macrotask boundaries separate us from the worker returning
    // to READY (stop delivery + worker reply delivery), so ABORTING is reliably
    // observable here. This makes the termination assertions below non-vacuous:
    // the worker genuinely entered the abort path rather than completing first.
    expect(
      db.debug?.workers.some((worker) => worker.status === 'ABORTING'),
    ).toBe(true);

    expect(records.some((record) => record.terminated)).toBe(false);
    expect(records.length).toBe(2);
  });
});

describe('a worker killed silently', () => {
  // The drain bound from Task 6, provable only now: without the prompt abort
  // the caller never reaches the drain at all.
  // Falsifiable: remove the timer from the drain race in pool.ts — the slot is
  // then never reclaimed and the last two assertions fail.
  it('is presumed dead when it never answers the stop request', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000), [], {
      signal: AbortSignal.timeout(200),
    });
    await sleep(100);
    records[0].worker.terminate(); // silent death: no event of any kind

    await expect(running).rejects.toThrow();
    await sleep(2000); // drainTimeout, then the replacement's boot
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2);
  });
});
