import { describe, expect, it } from 'vitest';
import {
  allocateShards,
  matchProjects,
  resolveConcurrency,
  runBounded,
  runPool,
} from '../../scripts/parallel.ts';

describe('resolveConcurrency', () => {
  it('takes a positive integer from BSQ_TEST_JOBS, beyond the default cap too', () => {
    expect(resolveConcurrency('5', 16)).toBe(5);
    expect(resolveConcurrency('1', 16)).toBe(1);
    expect(resolveConcurrency('40', 4)).toBe(40);
  });

  it('defaults to every CPU but one, capped at 12', () => {
    expect(resolveConcurrency(undefined, 16)).toBe(12);
    expect(resolveConcurrency(undefined, 64)).toBe(12);
    expect(resolveConcurrency(undefined, 13)).toBe(12);
    expect(resolveConcurrency(undefined, 8)).toBe(7);
    // A 4-vCPU `ubuntu-latest`.
    expect(resolveConcurrency(undefined, 4)).toBe(3);
  });

  it('never goes below 1', () => {
    expect(resolveConcurrency(undefined, 2)).toBe(1);
    expect(resolveConcurrency(undefined, 1)).toBe(1);
  });

  it('rejects anything but a positive integer, naming the variable', () => {
    for (const bad of ['0', '-3', '2.5', 'abc', '', ' ', '3x', '1e1']) {
      expect(() => resolveConcurrency(bad, 16), bad).toThrow(/BSQ_TEST_JOBS/);
    }
  });
});

describe('matchProjects', () => {
  const names = [
    'unit',
    'chrome · A/sync',
    'chrome · B/sync',
    'firefox · A/sync',
    'isolated chrome · A/sync',
    'conformance chrome',
  ];

  it('treats * as any run of characters and anchors both ends', () => {
    // Falsifiable: an unanchored match would pull "isolated chrome · …" in.
    expect(matchProjects(['chrome ·*'], names)).toEqual([
      'chrome · A/sync',
      'chrome · B/sync',
    ]);
    expect(matchProjects(['isolated *'], names)).toEqual([
      'isolated chrome · A/sync',
    ]);
  });

  it('matches a literal name exactly, and ignores case as Vitest does', () => {
    expect(matchProjects(['unit'], names)).toEqual(['unit']);
    expect(matchProjects(['UNIT'], names)).toEqual(['unit']);
    expect(matchProjects(['conformance chrome'], names)).toEqual([
      'conformance chrome',
    ]);
  });

  it('takes regex metacharacters literally', () => {
    expect(() => matchProjects(['chrome .*'], names)).toThrow(/chrome \.\*/);
    expect(matchProjects(['chrome · A/sync'], names)).toEqual([
      'chrome · A/sync',
    ]);
  });

  it('unions several globs, each project once, in the order of the names', () => {
    expect(matchProjects(['firefox ·*', 'unit', 'firefox ·*'], names)).toEqual([
      'unit',
      'firefox · A/sync',
    ]);
  });

  it('throws on a glob that matches nothing, naming it', () => {
    expect(() => matchProjects(['unit', 'safari ·*'], names)).toThrow(
      /safari ·\*/,
    );
    expect(() => matchProjects(['unit'], [])).toThrow(/unit/);
  });
});

describe('allocateShards', () => {
  const shards = (
    projects: { name: string; files: number }[],
    concurrency: number,
  ) => allocateShards(projects, concurrency).map((p) => p.shards);

  it('splits the concurrency in proportion to the file counts', () => {
    expect(
      shards(
        [
          { name: 'a', files: 12 },
          { name: 'b', files: 12 },
          { name: 'c', files: 3 },
        ],
        12,
      ),
    ).toEqual([5, 5, 1]);
    expect(
      shards(
        [
          { name: 'a', files: 30 },
          { name: 'b', files: 10 },
        ],
        8,
      ),
    ).toEqual([6, 2]);
  });

  it('gives every project at least one shard', () => {
    // 1 of 101 files rounds to 0 shards of 4.
    expect(
      shards(
        [
          { name: 'big', files: 100 },
          { name: 'tiny', files: 1 },
        ],
        4,
      ),
    ).toEqual([4, 1]);
    expect(
      shards(
        [
          { name: 'a', files: 5 },
          { name: 'b', files: 5 },
          { name: 'c', files: 5 },
        ],
        1,
      ),
    ).toEqual([1, 1, 1]);
  });

  it('never gives a project more shards than it has files', () => {
    expect(shards([{ name: 'a', files: 2 }], 12)).toEqual([2]);
    expect(
      shards(
        [
          { name: 'a', files: 2 },
          { name: 'b', files: 1 },
        ],
        12,
      ),
    ).toEqual([2, 1]);
  });

  it('keeps the projects, their order and their file counts', () => {
    expect(
      allocateShards(
        [
          { name: 'x', files: 4 },
          { name: 'y', files: 4 },
        ],
        4,
      ),
    ).toEqual([
      { name: 'x', files: 4, shards: 2 },
      { name: 'y', files: 4, shards: 2 },
    ]);
    expect(allocateShards([], 12)).toEqual([]);
  });
});

describe('runPool', () => {
  const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

  it('never runs more than the concurrency at once, and uses all of it', async () => {
    let active = 0;
    let peak = 0;
    await runPool(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      },
    );
    expect(peak).toBe(3);
  });

  it('collects every result, in the order of the items', async () => {
    const results = await runPool([30, 1, 15, 2], 2, async (ms, index) => {
      await tick(ms);
      return `${index}:${ms}`;
    });
    expect(results).toEqual([
      { status: 'fulfilled', value: '0:30' },
      { status: 'fulfilled', value: '1:1' },
      { status: 'fulfilled', value: '2:15' },
      { status: 'fulfilled', value: '3:2' },
    ]);
  });

  it('keeps going when a job throws, and reports it', async () => {
    // Falsifiable: a pool that lets the rejection escape stops starting jobs.
    const ran: number[] = [];
    const boom = new Error('boom');
    const results = await runPool([0, 1, 2, 3, 4], 2, async (item) => {
      ran.push(item);
      await tick();
      if (item === 1) throw boom;
      return item;
    });
    expect(ran.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(results[1]).toEqual({ status: 'rejected', reason: boom });
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
  });

  it('survives a job that throws synchronously', async () => {
    const results = await runPool([0, 1], 1, (item) => {
      if (item === 0) throw new Error('sync');
      return Promise.resolve(item);
    });
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('copes with no item, and with more concurrency than items', async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
    expect(await runPool([7], 4, async (n) => n)).toEqual([
      { status: 'fulfilled', value: 7 },
    ]);
  });

  it('rejects a concurrency below 1', async () => {
    await expect(runPool([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe('runBounded', () => {
  it('resolves with error set when the child fails to start', async () => {
    // Falsifiable: runBounded without an 'error' listener on the child never
    // settles for a command that cannot start — removing that listener turns
    // this test into a timeout instead of a pass. Verified by hand: with the
    // listener commented out, this test hits Vitest's test timeout
    // instead of resolving.
    const result = await runBounded('bsq-parallel-nonexistent-binary', [], {
      env: process.env,
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error?.code).toBe('ENOENT');
  });

  it('kills a child that outlives its timeout', async () => {
    // Falsifiable: removing the SIGKILL call from runBounded's timer lets the
    // 5s child run to completion instead of being cut off — the assertion on
    // elapsed time (and, with it, this test staying well under `sleep 5`'s
    // 5000ms) would fail. Verified by hand: with the kill removed, this test
    // takes roughly 5s instead of ~200ms and its elapsed-time assertion fails.
    const started = Date.now();
    const result = await runBounded('sleep', ['5'], {
      env: process.env,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(4000);
  });
});
