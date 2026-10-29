// Run it with V8's `gc` exposed on globalThis, which only this file needs:
//
//   BSQ_EXPOSE_GC=1 pnpm exec vitest run --configLoader runner --project 'chrome ·*' tests/browser/pairs/abandon-gc.test.ts
//
// Without that variable `globalThis.gc` is undefined and these tests skip
// themselves — expected, not a failure, under `pnpm test` or a git hook.
//
// This covers the collection path only. The repair itself — an abandoned
// generator giving its worker back at a timeout's deadline and at a
// signal's abort — is pinned deterministically, with no garbage collection
// and no browser flag, by tests/browser/abandon.test.ts.
//
// Measured under rstest (before the move to Vitest), when the file held the
// two chunk() tests: 13/13 real (non-skipped) green runs, and, as the
// falsifier, commenting out the `registry.watch(gen, held, token)` registration
// in src/queries.ts makes both of them hard-time out at 60000 ms with all ten
// retry rounds exhausted, rather than pass. The file now holds four tests, the
// two chunk() ones and their stream() twins. Re-run under Vitest on
// 2026-10-19 with BSQ_EXPOSE_GC=1: the four pass on Chrome and are skipped on
// Firefox, which has no --expose-gc. The falsifier is what tells a future
// reader this test is worth re-running at all.
import { describe, expect, it } from 'vitest';
import { createTestClient, nextTask, scaled, sleep } from '../helpers';

const forceGC = (globalThis as { gc?: () => void }).gc;

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000) ' +
  'SELECT x FROM c';

describe('an abandoned generator is recovered at collection', () => {
  it(
    'gives the worker back with no timeout and no signal',
    async ({ skip }) => {
      if (forceGC === undefined)
        return skip('this browser was not launched with --expose-gc');
      const gc = forceGC;
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (n INTEGER)');
        await db.run(SEED);

        await (async () => {
          const rows = db.chunk('SELECT n FROM t', [], { chunkSize: 10 });
          await rows.next();
          await nextTask();
        })();

        // Bounded retry: one collection is not a guarantee, and a hang is not
        // a report. Ten rounds, then a verdict either way.
        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          gc();
          await sleep(100);
          const read = db.all('SELECT 1 AS ok').then(() => true);
          read.catch(() => {});
          served = await Promise.race([read, sleep(200).then(() => false)]);
        }
        expect(served).toBe(true);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  it(
    'gives the worker back with a signal the caller keeps alive',
    async ({ skip }) => {
      if (forceGC === undefined)
        return skip('this browser was not launched with --expose-gc');
      const gc = forceGC;
      // The other case is the easy one: with neither a `timeout` nor a
      // `signal`, chunk() attaches no listener and nothing outside the
      // generator refers to its scope at all.
      //
      // This is the half that can go wrong. A `signal` makes chunk() attach an
      // abort listener, the CALLER's controller holds that listener, and the
      // listener holds the cleanup's held value — so if anything on that chain
      // reached the generator, the generator would never be collected, the
      // registry would never fire, and the whole repair would do nothing while
      // every test in this repository stayed green. D3 is the rule that keeps
      // it from reaching; this is the test that would notice if it did.
      const controller = new AbortController();
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (n INTEGER)');
        await db.run(SEED);

        await (async () => {
          const rows = db.chunk('SELECT n FROM t', [], {
            chunkSize: 10,
            signal: controller.signal,
          });
          await rows.next();
          await nextTask();
        })();

        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          gc();
          await sleep(100);
          const read = db.all('SELECT 1 AS ok').then(() => true);
          read.catch(() => {});
          served = await Promise.race([read, sleep(200).then(() => false)]);
        }
        expect(served).toBe(true);
        // And it was the collection that did it, not the D7 abort path: the
        // controller is still held, right here, and was never aborted.
        expect(controller.signal.aborted).toBe(false);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  it(
    'gives the worker back with no timeout and no signal, from stream()',
    async ({ skip }) => {
      if (forceGC === undefined)
        return skip('this browser was not launched with --expose-gc');
      const gc = forceGC;
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (n INTEGER)');
        await db.run(SEED);

        await (async () => {
          const rows = db.stream('SELECT n FROM t', [], { chunkSize: 10 });
          await rows.next();
          await nextTask();
        })();

        // Bounded retry: one collection is not a guarantee, and a hang is not
        // a report. Ten rounds, then a verdict either way.
        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          gc();
          await sleep(100);
          const read = db.all('SELECT 1 AS ok').then(() => true);
          read.catch(() => {});
          served = await Promise.race([read, sleep(200).then(() => false)]);
        }
        expect(served).toBe(true);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  it(
    'gives the worker back with a signal the caller keeps alive, from stream()',
    async ({ skip }) => {
      if (forceGC === undefined)
        return skip('this browser was not launched with --expose-gc');
      const gc = forceGC;
      // The other case is the easy one: with neither a `timeout` nor a
      // `signal`, stream() attaches no listener and nothing outside the
      // generator refers to its scope at all.
      //
      // This is the half that can go wrong. A `signal` makes stream() attach an
      // abort listener, the CALLER's controller holds that listener, and the
      // listener holds the cleanup's held value — so if anything on that chain
      // reached the generator, the generator would never be collected, the
      // registry would never fire, and the whole repair would do nothing while
      // every test in this repository stayed green. D3 is the rule that keeps
      // it from reaching; this is the test that would notice if it did.
      const controller = new AbortController();
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (n INTEGER)');
        await db.run(SEED);

        await (async () => {
          const rows = db.stream('SELECT n FROM t', [], {
            chunkSize: 10,
            signal: controller.signal,
          });
          await rows.next();
          await nextTask();
        })();

        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          gc();
          await sleep(100);
          const read = db.all('SELECT 1 AS ok').then(() => true);
          read.catch(() => {});
          served = await Promise.race([read, sleep(200).then(() => false)]);
        }
        expect(served).toBe(true);
        // And it was the collection that did it, not the D7 abort path: the
        // controller is still held, right here, and was never aborted.
        expect(controller.signal.aborted).toBe(false);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );
});
