import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  exercised,
  longQuery,
  scaled,
  sleep,
} from '../helpers';

/**
 * A statement's own `timeout` inside a transaction, bounding it exactly like a
 * per-statement `signal` does: the statement rejects alone, uncaught it rolls
 * the transaction back, caught it lets the callback continue to COMMIT. Reads
 * only: a write abandoned by its own timeout abandons the whole transaction,
 * which tests/browser/tx-abort.test.ts pins.
 *
 * `longQuery` is a single-row aggregate: on a `sync` build with no
 * cross-origin isolation, worker.ts installs no progress handler at all, so
 * the recursive CTE runs to completion in one uninterruptible step()
 * regardless of the timeout; on `async`/`jspi` a statement with a timeout
 * yields periodically and can actually be cut (mem:vfs, HANDLE-1). Either
 * way the transaction's own deadline rejects on schedule, which is the whole
 * subject here — the test follows the target (spec 2026-09-15, A5), no
 * `needs` declared. The size below (2 000 000) is chosen so that natural
 * completion is comfortably above the 200 ms budget on both engines (~500 ms
 * Chromium, ~2.3 s Firefox, measured on `sync`) while staying well inside
 * each test's own timeout even when the statement is not actually cut.
 */
// Only its timeout ends it, on a build that can cut a statement: no bet on
// how long it runs (`mem:follow-ups/time-based-tests`, relative durations).
const ENDLESS = longQuery(2_000_000_000);
// A build that cannot cut one runs it to its end, so it must be finite — and
// outlast the 200 ms deadline, a bet on its length. When it ends first, the
// test says it was not exercised rather than going red: 2 000 000 did on a
// starved Windows Firefox runner (2026-11-04, run 41847018002).
const FINITE = longQuery(5_000_000);
const UNCUT = 'the statement ended before its 200 ms timeout';

const rejectsAndRollsBack = async (sql: string, cut: boolean) => {
  const db = await createTestClient({ poolSize: 1 });
  try {
    await db.run('CREATE TABLE t (a INTEGER)');
    const outcome = await db
      .transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
        await tx.all(sql, [], { timeout: 200 });
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (!cut && !(await exercised(outcome !== undefined, UNCUT))) return;
    expect(outcome).toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 200 });
    expect(await db.all('SELECT a FROM t')).toEqual([]);
  } finally {
    await db.close();
  }
};

const catchesAndCommits = async (sql: string, cut: boolean) => {
  const db = await createTestClient({ poolSize: 1 });
  try {
    await db.run('CREATE TABLE t (a INTEGER)');
    let caughtCode: string | undefined;
    // What a red must say: whether all() resolved or threw something without
    // a code, and after how long.
    let outcome = 'resolved';
    let resolved = false;
    await db.transaction(async (tx) => {
      const started = performance.now();
      try {
        const rows = await tx.all(sql, [], { timeout: 200 });
        resolved = true;
        outcome = `resolved with ${rows.length} row(s)`;
      } catch (error) {
        caughtCode = (error as { code?: string }).code;
        outcome = `threw ${String(error)}`;
      } finally {
        outcome += ` after ${Math.round(performance.now() - started)} ms`;
      }
      await tx.run('INSERT INTO t VALUES (1)');
    });
    if (!cut && !(await exercised(!resolved, `${UNCUT} (${outcome})`))) return;
    expect(caughtCode, outcome).toBe('OPERATION_TIMEOUT');
    expect(await db.all('SELECT a FROM t')).toEqual([{ a: 1 }]);
  } finally {
    await db.close();
  }
};

describe('a statement timeout inside a transaction', () => {
  it(
    'rejects the transaction, uncaught, and rolls back an earlier write',
    { tags: ['requires:interruptible'], timeout: scaled(15000) },
    () => rejectsAndRollsBack(ENDLESS, true),
  );

  it(
    'rejects the transaction, uncaught, and rolls back an earlier write, on a build that cannot cut it',
    { tags: ['excludes:interruptible'], timeout: scaled(30000) },
    () => rejectsAndRollsBack(FINITE, false),
  );

  it(
    'lets the callback catch the timeout and continue to COMMIT',
    { tags: ['requires:interruptible'], timeout: scaled(15000) },
    () => catchesAndCommits(ENDLESS, true),
  );

  it(
    'lets the callback catch the timeout and continue to COMMIT, on a build that cannot cut it',
    { tags: ['excludes:interruptible'], timeout: scaled(30000) },
    () => catchesAndCommits(FINITE, false),
  );

  it(
    'rejects a tx.chunk() whose consumer pauses past the timeout between chunks',
    async () => {
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (x INTEGER)');
        await db.run(
          'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1001) ' +
            'INSERT INTO t SELECT x FROM c',
        );

        await expect(
          db.transaction(async (tx) => {
            for await (const rows of tx.chunk<{ x: number }>(
              'SELECT x FROM t',
              [],
              {
                timeout: 100,
              },
            )) {
              void rows;
              // A streaming consumer that never pauses tests nothing here: the
              // credit window keeps a chunk in flight regardless of the timeout.
              await sleep(150);
            }
          }),
        ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 100 });
      } finally {
        await db.close();
      }
    },
    scaled(15000),
  );
});
