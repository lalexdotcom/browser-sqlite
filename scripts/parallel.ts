/**
 * What `scripts/test-parallel.ts` and `scripts/test-matrix.ts` share: running
 * several Vitest processes at once. The WebdriverIO provider runs one file at a
 * time per project and a Vitest run takes its projects one after another, so
 * one invocation cannot parallelize; several processes can, each with its own
 * WebDriver session — its own browser profile and its own server port.
 */
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** What `runBounded` resolves with — never rejects, so every outcome round-trips through here. */
export type BoundedResult = {
  readonly output: string;
  readonly timedOut: boolean;
  /** The child's exit code; null when a signal ended it or it never started. */
  readonly exitCode: number | null;
  readonly error: (Error & { readonly code?: string }) | null;
};

/** Process groups of the runs in flight, so a signal to the launcher reaches them. */
const live = new Set<number>();

/** Kills every run in flight (each is its own process group); a group already gone is fine. */
export function killLive(signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const pid of live) {
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: nothing left in the group.
    }
  }
}

/**
 * Ctrl-C and a CI cancellation: the runs are detached groups, so signalling the
 * launcher's own group (as `scripts/bounded.ts` does) would leave them alive.
 */
export function killLiveOnSignal(): void {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.on(signal, () => {
      killLive('SIGKILL');
      process.exit(code);
    });
  }
}

/**
 * Spawns `command` with `args`, collecting combined stdout+stderr and
 * bounding the run to `timeoutMs`.
 *
 * Two distinct failure shapes, both reported through the return value rather
 * than a thrown/rejected promise, so a caller never has to choose between
 * `try/catch` and `.then` to cover every outcome:
 *
 * - The child starts but outlives `timeoutMs`: the whole process group is
 *   killed (`detached: true` + `process.kill(-pid, 'SIGKILL')` — the same
 *   pattern `scripts/consumer-smoke.ts` uses, because `pnpm exec vitest`
 *   forks the browser drivers and the browsers themselves, which survive
 *   killing only the direct child) and `timedOut: true` is returned.
 * - The child never starts at all (`ENOENT`, `EACCES`, …): Node emits
 *   `'error'` instead of `'close'`, and never emits `'close'` for a process
 *   that was never spawned. A promise built on `'close'` alone never settles
 *   — the exact hang this script exists to prevent, one layer earlier than
 *   the timeout above. `error` is returned instead, and the timer is cleared
 *   so it cannot later try to kill a pid that was never assigned.
 *
 * A `settled` guard makes the two mutually exclusive: Node's own contract
 * still allows a `'close'` after an `'error'` for the same child, and only
 * the first of the two may resolve the promise.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  {
    cwd,
    env,
    timeoutMs,
  }: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  },
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid !== undefined) live.add(child.pid);
    let output = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const settle = (result: BoundedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) live.delete(child.pid);
      resolve(result);
    };
    child.stdout?.on('data', (d) => {
      output += String(d);
    });
    child.stderr?.on('data', (d) => {
      output += String(d);
    });
    child.on('error', (error) =>
      settle({ output, timedOut, exitCode: null, error }),
    );
    child.on('close', (exitCode) =>
      settle({ output, timedOut, exitCode, error: null }),
    );
  });
}

/**
 * How many processes run at once. `BSQ_TEST_JOBS` (a positive integer) wins;
 * otherwise every CPU but one, at most 6: each process is a browser, a driver
 * and a server, and cells slow each other down — measured 2026-10-13 on 16
 * cores, the matrix took 949 s at 6, 906 s at 8 and 842 s at 12, for 26% more
 * CPU at 8 than at 6.
 */
export function resolveConcurrency(
  env: string | undefined,
  cpus: number = availableParallelism(),
): number {
  if (env === undefined) return Math.max(1, Math.min(6, cpus - 1));
  if (!/^[1-9]\d*$/.test(env)) {
    throw new Error(`BSQ_TEST_JOBS: "${env}" is not a positive integer`);
  }
  return Number(env);
}

/**
 * The names `--project` globs select, in the order of `names`. `*` matches any
 * run of characters, the whole name and without regard to case — Vitest's own
 * rule. A glob that selects nothing is an error, so a typo cannot test nothing.
 */
export function matchProjects(
  globs: readonly string[],
  names: readonly string[],
): string[] {
  const matchers = globs.map((glob) => ({
    glob,
    regex: new RegExp(
      `^${glob
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
      'i',
    ),
  }));
  for (const { glob, regex } of matchers) {
    if (!names.some((name) => regex.test(name))) {
      throw new Error(`--project "${glob}" matches no project`);
    }
  }
  return names.filter((name) => matchers.some((m) => m.regex.test(name)));
}

/**
 * Shards per project: the concurrency shared out in proportion to the files, at
 * least one, at most one per file (a shard without a file runs nothing).
 */
export function allocateShards(
  projects: readonly { readonly name: string; readonly files: number }[],
  concurrency: number,
): { name: string; files: number; shards: number }[] {
  const total = projects.reduce((sum, p) => sum + p.files, 0);
  return projects.map(({ name, files }) => ({
    name,
    files,
    shards: Math.max(
      1,
      Math.min(files, Math.round((concurrency * files) / total)),
    ),
  }));
}

/**
 * Runs `worker` over `items`, at most `concurrency` at once. Never rejects for
 * a job: a throwing worker is a `rejected` entry and the others carry on. The
 * results come in the order of `items`.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!(concurrency >= 1)) {
    throw new RangeError(`runPool: concurrency ${concurrency} is below 1`);
  }
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  );
  return results;
}

/**
 * Builds tests/build/ once, before any process starts: every browser project's
 * globalSetup builds it unless `BSQ_TEST_BUILT=1`, and several at once would
 * race on the directory. Returns the environment every child gets.
 */
export function buildOnce(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.BSQ_TEST_BUILT !== '1') {
    const built = spawnSync(
      'pnpm',
      ['exec', 'rslib', 'build', '-c', 'rslib.test.config.ts'],
      { cwd: ROOT, env, stdio: 'inherit' },
    );
    if (built.status !== 0) {
      throw new Error(
        `rslib.test.config.ts: the build failed (exit ${built.status})`,
      );
    }
  }
  return { ...env, BSQ_TEST_BUILT: '1' };
}

/**
 * The environment of one job: its own Vite cache, read by `vitest.config.ts`.
 * Processes that share a project's dep-optimizer cache race on a cold or stale
 * one — each commits its optimization by renaming `deps` with no lock, and the
 * loser fails `ENOENT` mid-run or leaves a `deps_temp_*` orphan. Named after
 * the job, so the same job finds its cache warm on the next run.
 */
export function jobEnv(
  env: NodeJS.ProcessEnv,
  jobId: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    BSQ_VITE_CACHE_DIR: join(ROOT, 'node_modules/.vite/jobs', jobId),
  };
}

/** One process of a parallel run: a project, or one shard of it. */
export type Job = {
  readonly id: string;
  readonly project: string;
  readonly shard: readonly [number, number] | null;
};

/**
 * The jobs of a run: `unit` once, every other project cut into its shards. An id
 * names the job's blob and log, so two jobs must never share one: project names
 * that collapse to the same file name are an error naming both.
 */
export function planJobs(
  projects: ReadonlyMap<string, number>,
  names: readonly string[],
  concurrency: number,
): Job[] {
  const slug = (name: string) => name.replace(/[^\w.-]+/g, '-');
  const jobs: Job[] = [];
  const browser = names
    .filter((name) => name !== 'unit')
    .map((name) => ({ name, files: projects.get(name) as number }));
  if (names.includes('unit')) {
    jobs.push({ id: 'unit', project: 'unit', shard: null });
  }
  for (const { name, shards } of allocateShards(browser, concurrency)) {
    for (let shard = 1; shard <= shards; shard++) {
      jobs.push({
        id: shards > 1 ? `${slug(name)}.${shard}of${shards}` : slug(name),
        project: name,
        shard: shards > 1 ? [shard, shards] : null,
      });
    }
  }
  const owners = new Map<string, string>();
  for (const { id, project } of jobs) {
    const owner = owners.get(id);
    if (owner !== undefined && owner !== project) {
      throw new Error(
        `projects "${owner}" and "${project}" would share the job id "${id}" (one blob, one log)`,
      );
    }
    owners.set(id, project);
  }
  return jobs;
}

/** What a job left of its blob: `unparsable` is a file Vitest did not finish writing. */
export type BlobState = 'ok' | 'missing' | 'unparsable';

/**
 * The jobs that did not finish cleanly, each with why. A job killed by its
 * timer or that never started failed whatever it left behind — a browser can
 * hang in teardown after writing its blob — and a missing or truncated blob is
 * a job whose tests the merge lacks. A job whose tests failed is NOT here: its
 * blob is complete and the merge reports the failures.
 */
export function findFailedJobs<J>(
  outcomes: readonly {
    readonly job: J;
    readonly timedOut: boolean;
    readonly error: Error | null;
    readonly blob: BlobState;
  }[],
): { job: J; reason: string }[] {
  return outcomes.flatMap(({ job, timedOut, error, blob }) => {
    const reasons = [
      ...(timedOut ? ['timed out'] : []),
      ...(error ? [`could not run: ${error.message}`] : []),
      ...(blob === 'missing' ? ['no blob'] : []),
      ...(blob === 'unparsable' ? ['blob does not parse'] : []),
    ];
    return reasons.length > 0 ? [{ job, reason: reasons.join(', ') }] : [];
  });
}
