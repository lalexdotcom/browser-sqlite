import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery, sleep } from './helpers';

// Two rows far apart: the first is immediate, the second exists only once a
// 10 M-step recursion has run, in one `sqlite.step()`. N=10_000_000 takes
// ~2 082 ms on Chromium async (measured 2026-09-05, see interrupt.test.ts),
// well above the 1 500 ms bound; Firefox runs it 4-5x slower, which is why
// each test carries its own timeout below.
const SLOW_SECOND_ROW = `SELECT 1 AS n UNION ALL SELECT (${longQuery(10_000_000)})`;
const SLOW_SECOND_ROW_CTE = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 10000000) SELECT 0 AS n UNION ALL SELECT count(*) FROM c`;

describe('leaving a read early, with no signal and no timeout', () => {
  // Falsifiable: install the progress handler only for a statement that was
  // given a signal. The worker then runs the second row's step to its end
  // before the lease comes back, and the SELECT 1 below pays for all of it.
  it('first() cuts the step it left running', async ({ skip }) => {
    // poolSize 1: the next query MUST land on the worker that served first().
    const db = await createTestClient({
      poolSize: 1,
      needs: ['interruptible'],
      skip,
    });
    try {
      await db.read('SELECT 1');
      expect(await db.first<{ n: number }>(SLOW_SECOND_ROW)).toEqual({ n: 1 });
      // `started` is the moment first() resolved: the stop leaves with it, and
      // the timer captures stop -> worker drain -> SELECT 1. Broken, the step
      // runs to its end and the total lands past the bound.
      const started = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      await db.close();
    }
  }, 90_000);

  // Falsifiable: same as above, for a break out of chunk().
  it('a break out of chunk() cuts the step it left running', async ({
    skip,
  }) => {
    const db = await createTestClient({
      poolSize: 1,
      needs: ['interruptible'],
      skip,
    });
    try {
      await db.read('SELECT 1');
      for await (const rows of db.chunk<{ n: number }>(
        SLOW_SECOND_ROW_CTE,
        [],
        {
          chunkSize: 1,
        },
      )) {
        expect(rows).toEqual([{ n: 0 }]);
        // The credit window lets the worker go straight into the count; this
        // leaves it time to be inside that step before the break.
        await sleep(100);
        break;
      }
      const started = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      await db.close();
    }
  }, 90_000);
});
