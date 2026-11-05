import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  longQuery,
  reachedWithin,
  theQueryIsComputing,
} from '../helpers';
import { exercised } from '../helpers/exercised';

// Two rows far apart: the first is immediate, the second exists only once a
// 2 G-step recursion has run, in one `sqlite.step()`. Run to its end that takes
// minutes on either engine (40 M took ~8 s on Chromium async, see
// interrupt.test.ts), past each test's timeout, which is the bound. Only the
// broken case pays for N: working, the step is cut at once.
const SLOW_SECOND_ROW = `SELECT 1 AS n UNION ALL SELECT (${longQuery(2_000_000_000)})`;
const SLOW_SECOND_ROW_CTE = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000000) SELECT 0 AS n UNION ALL SELECT count(*) FROM c`;

describe('leaving a read early, with no signal and no timeout', {
  tags: ['requires:interruptible'],
}, () => {
  // Falsifiable: install the progress handler only for a statement that was
  // given a signal. The worker then runs the second row's step to its end
  // before the lease comes back, and the SELECT 1 below pays for all of it.
  it('first() cuts the step it left running', async () => {
    // poolSize 1: the next query MUST land on the worker that served first().
    const db = await createTestClient({ poolSize: 1, debug: true });
    let computing = false;
    try {
      await db.all('SELECT 1');
      expect(await db.first<{ n: number }>(SLOW_SECOND_ROW)).toEqual({ n: 1 });
      // The stop leaves with first(). Broken, the step runs to its end and the
      // read below waits it out past the test's timeout.
      expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      // The cut proves nothing unless the worker was inside the count when the
      // stop came. Its stage is recorded when it closes, with the reply that
      // the SELECT 1 above has waited behind.
      const record = (db.debug?.requests ?? [])
        .flatMap((r) => r.queries)
        .filter((q) => q.sql === SLOW_SECOND_ROW)
        .at(-1);
      computing = record?.stages.computing !== undefined;
    } finally {
      await db.close();
    }
    if (
      !(await exercised(
        computing,
        'the count was not computing when first() left it',
      ))
    )
      return;
  });

  // Falsifiable: same as above, for a break out of chunk().
  it('a break out of chunk() cuts the step it left running', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    let computing = false;
    try {
      await db.all('SELECT 1');
      for await (const rows of db.chunk<{ n: number }>(
        SLOW_SECOND_ROW_CTE,
        [],
        {
          chunkSize: 1,
        },
      )) {
        expect(rows).toEqual([{ n: 0 }]);
        // The credit window lets the worker go straight into the count; wait
        // until it is inside that step before the break.
        computing = await reachedWithin(
          theQueryIsComputing(db, SLOW_SECOND_ROW_CTE),
          5_000,
        );
        break;
      }
      expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
    if (
      !(await exercised(
        computing,
        'the count was not computing before the break',
      ))
    )
      return;
  });
});
