import { describe, expect, it } from '@rstest/core';
import { createTestClient, sleep } from './helpers';

const forceGC = (globalThis as { gc?: () => void }).gc;

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000) ' +
  'SELECT x FROM c';

describe('an abandoned generator is recovered at collection', () => {
  if (!forceGC) {
    it.skip('skipped — this browser was not launched with --expose-gc', () => {});
  } else {
    it('gives the worker back with no timeout and no signal', async () => {
      const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
      try {
        await db.write('CREATE TABLE t (n INTEGER)');
        await db.write(SEED);

        await (async () => {
          const rows = db.chunk('SELECT n FROM t', [], { chunkSize: 10 });
          await rows.next();
          await sleep(0);
        })();

        // Bounded retry: one collection is not a guarantee, and a hang is not
        // a report. Ten rounds, then a verdict either way.
        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          forceGC();
          await sleep(100);
          const read = db.read('SELECT 1 AS ok').then(() => true);
          read.catch(() => {});
          served = await Promise.race([read, sleep(200).then(() => false)]);
        }
        expect(served).toBe(true);
      } finally {
        await db.close();
      }
    }, 60_000);
  }
});
