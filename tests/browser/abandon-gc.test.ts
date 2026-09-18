// This test only runs, rather than skipping, under a Chromium launched with
// V8's `gc` exposed on globalThis. That is not part of `rstest.config.ts`:
// the file defines a single `chromium` project whose launch args are shared
// by every browser test, so putting `--expose-gc` there would change what
// every other test in tests/browser/ runs under, and rstest refuses to run
// a second browser-enabled project alongside it with different
// provider options (all such projects in one run must share
// provider/browser/headless/providerOptions). So the flag is passed at
// invocation time only, via rstest's CLI override, and never touches the
// checked-in config:
//
//   pnpm exec rstest --project 'chromium*' run tests/browser/abandon-gc.test.ts \
//     --browser.providerOptions.launch.args.0="--js-flags=--expose-gc"
//
// `chromium*` matches every chromium project (one per target, spec
// 2026-09-15, A5) — there is no longer a project named plain `chromium`.
//
// Without that flag `globalThis.gc` is undefined and this test skips itself
// below — that is expected, not a failure, when run through `pnpm test` or
// a git hook.
//
// This covers the collection path only. The repair itself — an abandoned
// generator giving its worker back at a timeout's deadline and at a
// signal's abort — is pinned deterministically, with no garbage collection
// and no browser flag, by tests/browser/abandon.test.ts.
//
// Verified under the command above, both cases: 13/13 real (non-skipped) green
// runs, and — as the falsifier — commenting out the `registry.watch(gen, held,
// token)` registration in src/queries.ts makes BOTH tests hard-time out at
// 60000 ms with all ten retry rounds exhausted, rather than pass. That is
// what tells a future reader this test is worth re-running at all.
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
      const db = await createTestClient({ poolSize: 1 });
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

    it('gives the worker back with a signal the caller keeps alive', async () => {
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
        await db.write('CREATE TABLE t (n INTEGER)');
        await db.write(SEED);

        await (async () => {
          const rows = db.chunk('SELECT n FROM t', [], {
            chunkSize: 10,
            signal: controller.signal,
          });
          await rows.next();
          await sleep(0);
        })();

        let served = false;
        for (let round = 0; round < 10 && !served; round++) {
          forceGC();
          await sleep(100);
          const read = db.read('SELECT 1 AS ok').then(() => true);
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
    }, 60_000);
  }
});
