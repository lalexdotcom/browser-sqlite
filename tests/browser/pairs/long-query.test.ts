import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  interceptWorkers,
  killedStatementRuns,
  killSilently,
  longQuery,
  theQueryIsRunning,
  waitUntil,
} from '../helpers';

describe('a long single step', () => {
  // Falsifiable: bound the query itself with any timer and this fails.
  it('runs to completion untouched', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const rows = await db.all<{ n: number }>(longQuery(2_000_000));
    expect(rows[0]?.n).toBe(2_000_000);
  });

  // Falsifiable: drop the abort from the race in chunk() and go back to testing
  // `aborted` after the await — the rejection then waits for the sort to finish
  // and this exceeds its budget.
  it('gives the caller back control at the moment the signal fires', {
    tags: ['requires:two-workers', 'requires:interruptible'],
  }, async () => {
    // A second worker must be free to answer while the first is inside the
    // long sort, so the pair has to keep two. Interruptible too: uncut, the
    // teardown drains the whole 20M-row query.
    const db = await createTestClient({ poolSize: 2 });
    // Booted first: the bound is on the abort, not on the pool's startup.
    await db.all('SELECT 1');
    const started = performance.now();
    await expect(
      db.all(longQuery(20_000_000), [], {
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Falsifiable: remove both `interrupt()` calls, in reclaim() and in drain()'s
  // finally — the worker then goes RUNNING → READY without ABORTING. Either one
  // alone keeps it green: the abort listener reclaims before the finally runs.
  it('does not terminate the worker it abandoned', {
    tags: ['requires:two-workers', 'requires:interruptible'],
  }, async () => {
    const records = interceptWorkers();
    const db = await createTestClient({
      // Both workers must stay alive, so the pair has to keep two.
      // Interruptible too: uncut, the teardown drains the whole 20M-row query.
      poolSize: 2,
      drainTimeout: 60_000,
      debug: true,
    });
    await db.run('CREATE TABLE t (a)');

    await expect(
      db.all(longQuery(20_000_000), [], { signal: AbortSignal.timeout(200) }),
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
  it('is presumed dead when it never answers the stop request', async ({
    skip,
  }) => {
    const webkit = killedStatementRuns();
    if (webkit) return skip(webkit);
    const records = interceptWorkers();
    const db = await createTestClient({
      poolSize: 1,
      drainTimeout: 500,
      debug: true,
    });
    await db.run('CREATE TABLE t (a)');

    const sql = longQuery(20_000_000);
    const running = db.all(sql, [], {
      signal: AbortSignal.timeout(200),
    });
    await waitUntil(theQueryIsRunning(db, sql), 'the query to be running');
    killSilently(records[0].worker); // silent death: no event of any kind

    await expect(running).rejects.toThrow();
    // drainTimeout, then the replacement's boot. Bounded as the library's open
    // is: on Safari a worker that instantiates its wasm after another ran hot
    // wasm can stall for seconds (see lifecycle.test.ts).
    await waitUntil(
      () => records[1]?.received.includes('ready') ?? false,
      'the replacement to be ready',
      30_000,
    );
    const rows = await db.all<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2);
  });
});
