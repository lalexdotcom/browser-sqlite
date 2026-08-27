import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * `poolSize: 1` throughout this file. At the default size two executions of
 * the same SQL can land on two workers and compile once each — correct, and
 * unreadable as an assertion about caching.
 */
const single = { poolSize: 1, debug: true } as const;

/**
 * Every recorded execution of `sql`, oldest first. Selected by SQL rather
 * than by position: the barrier runs its own statement on the same worker,
 * so `queries.at(-1)` is not reliably the query the test just issued.
 */
const runsOf = (
  db: Awaited<ReturnType<typeof createTestClient>>,
  sql: string,
) =>
  (db.debug?.workers ?? [])
    .flatMap((w) => w.requests)
    .flatMap((r) => r.queries)
    .filter((q) => q.sql === sql);

describe('prepare counter', () => {
  it('reports one compilation for one statement', async () => {
    const db = await createTestClient(single);
    await db.write('CREATE TABLE t (a)');
    // Falsifiability: stop incrementing `prepared` in worker.ts's query loop
    // and this is 0.
    expect(runsOf(db, 'CREATE TABLE t (a)')[0]?.prepared).toBe(1);
    await db.close();
  });

  it('reports one compilation per statement of a multi-statement string', async () => {
    const db = await createTestClient(single);
    const sql = 'CREATE TABLE t (a); CREATE TABLE u (b)';
    await db.write(sql);
    // The premise Task 3 rests on, measured rather than assumed: wa-sqlite's
    // generator yields one statement per statement of the string.
    // Falsifiability: increment `prepared` once per query instead of once per
    // yielded statement and this is 1.
    expect(runsOf(db, sql)[0]?.prepared).toBe(2);
    await db.close();
  });
});
