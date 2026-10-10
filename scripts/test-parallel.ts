#!/usr/bin/env node
/**
 * Runs Vitest projects as several processes at once and reports them as one
 * run (spec 2026-10-10, § 4).
 *
 *   node scripts/test-parallel.ts --project <glob> [--project <glob>]… [-- <args for the merge>]
 *
 * Why: the WebdriverIO provider runs one file at a time per project and takes
 * its projects one after another, so one invocation cannot use the machine.
 * Several processes can: each has its own WebDriver session, so its own browser
 * profile (OPFS, IndexedDB, Web Locks) and its own server port.
 *
 * The globs are Vitest's `--project` globs, resolved against `vitest list`. Each
 * browser project is cut into shards in proportion to its files, so that about
 * `BSQ_TEST_JOBS` processes (default: every CPU but one, at most 12) run at
 * once; `unit` is one process. Each process writes a Vitest blob under
 * `<run>/blobs/` and its console under `<run>/logs/`; `vitest --merge-reports`
 * then reads the blobs as one run. The blobs have a directory of their own: the
 * merge reads every file in it. A job that ends without its blob (crash, kill,
 * timeout) fails the run, with its name and the end of its log.
 *
 * tests/build/ is built once before any process starts (they would race on it).
 * Runs are kept under `.test-parallel/` (gitignored), the newest KEEP_RUNS.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  allocateShards,
  buildOnce,
  killLiveOnSignal,
  matchProjects,
  ROOT,
  resolveConcurrency,
  runBounded,
  runPool,
} from './parallel.ts';

/** Each job is bounded by a timer this script owns, as a matrix cell is. */
const JOB_TIMEOUT_MS = 900_000;
const KEEP_RUNS = 10;
const TAIL_LINES = 60;
const UNIT = 'unit';

type Job = {
  readonly id: string;
  readonly project: string;
  readonly shard: readonly [number, number] | null;
};

function parseArgs(argv: readonly string[]) {
  const globs: string[] = [];
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i++) {
    const arg = argv[i];
    if (arg === '--project') {
      const glob = argv[++i];
      if (glob === undefined) throw new Error('--project needs a value');
      globs.push(glob);
    } else if (arg.startsWith('--project=')) {
      globs.push(arg.slice('--project='.length));
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (globs.length === 0) throw new Error('at least one --project is needed');
  return { globs, mergeArgs: argv.slice(i + 1) };
}

/** Files per project, from `vitest list` (a Node script cannot import the config: src/ has extensionless imports). */
function listProjects(env: NodeJS.ProcessEnv): Map<string, number> {
  const listed = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'list',
      '--configLoader',
      'runner',
      '--filesOnly',
      '--json',
    ],
    { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  let entries: { file: string; projectName: string }[];
  try {
    entries = JSON.parse(listed.stdout);
  } catch {
    throw new Error(
      `vitest list gave no JSON (exit ${listed.status}):\n${listed.stdout}${listed.stderr}`,
    );
  }
  const files = new Map<string, number>();
  for (const { projectName } of entries) {
    files.set(projectName, (files.get(projectName) ?? 0) + 1);
  }
  return files;
}

function planJobs(
  projects: Map<string, number>,
  names: readonly string[],
  concurrency: number,
): Job[] {
  const slug = (name: string) => name.replace(/[^\w.-]+/g, '-');
  const jobs: Job[] = [];
  const browser = names
    .filter((name) => name !== UNIT)
    .map((name) => ({ name, files: projects.get(name) as number }));
  if (names.includes(UNIT)) {
    jobs.push({ id: UNIT, project: UNIT, shard: null });
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
  return jobs;
}

const tailOf = (file: string) =>
  readFileSync(file, 'utf8').split('\n').slice(-TAIL_LINES).join('\n');

async function main() {
  const { globs, mergeArgs } = parseArgs(process.argv.slice(2));
  const concurrency = resolveConcurrency(process.env.BSQ_TEST_JOBS);
  const env = buildOnce(process.env);
  killLiveOnSignal();

  const projects = listProjects(env);
  const names = matchProjects(globs, [...projects.keys()]);
  const jobs = planJobs(projects, names, concurrency);

  const runsRoot = join(ROOT, '.test-parallel');
  const run = join(runsRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const blobs = join(run, 'blobs');
  const logs = join(run, 'logs');
  mkdirSync(blobs, { recursive: true });
  mkdirSync(logs, { recursive: true });
  for (const old of readdirSync(runsRoot).sort().slice(0, -KEEP_RUNS)) {
    rmSync(join(runsRoot, old), { recursive: true, force: true });
  }
  console.log(
    `${jobs.length} jobs, ${concurrency} at a time. Run under ${run}.`,
  );

  const start = Date.now();
  let done = 0;
  const missing: Job[] = [];
  const settled = await runPool(jobs, concurrency, async (job) => {
    const blob = join(blobs, `${job.id}.json`);
    const log = join(logs, `${job.id}.log`);
    const began = Date.now();
    const { output, timedOut, exitCode, error } = await runBounded(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--configLoader',
        'runner',
        '--project',
        job.project,
        ...(job.shard ? [`--shard=${job.shard[0]}/${job.shard[1]}`] : []),
        '--reporter=blob',
        `--outputFile=${blob}`,
      ],
      { cwd: ROOT, env, timeoutMs: JOB_TIMEOUT_MS },
    );
    writeFileSync(log, error ? `${output}\n${error.message}\n` : output);
    const ended = timedOut
      ? 'timed out'
      : error
        ? `error ${error.message}`
        : `exit ${exitCode}`;
    // A failed test still leaves its blob: the merge reports it. No blob is a
    // job that never finished.
    if (!existsSync(blob)) missing.push(job);
    console.log(
      `[${++done}/${jobs.length}] ${job.id}: ${ended} in ${Math.round((Date.now() - began) / 1000)}s${existsSync(blob) ? '' : ' (NO BLOB)'}`,
    );
  });
  settled.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      console.error(`${jobs[i].id}: ${String(outcome.reason)}`);
      if (!missing.includes(jobs[i])) missing.push(jobs[i]);
    }
  });
  console.log(
    `Jobs done in ${Math.round((Date.now() - start) / 1000)}s. Merging…\n`,
  );

  let status = missing.length > 0 ? 1 : 0;
  if (missing.length < jobs.length) {
    const merged = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        '--configLoader',
        'runner',
        '--merge-reports',
        blobs,
        '--reporter=default',
        ...mergeArgs,
      ],
      { cwd: ROOT, env, stdio: 'inherit' },
    );
    if (merged.status !== 0) status = 1;
  }
  for (const job of missing) {
    const log = join(logs, `${job.id}.log`);
    console.error(
      `\n--- ${job.id} ended without its blob; last ${TAIL_LINES} lines of ${log} ---\n${existsSync(log) ? tailOf(log) : '(no log)'}\n--- end ---`,
    );
  }
  if (missing.length > 0) {
    console.error(
      `\n${missing.length} of ${jobs.length} jobs left no blob: ${missing.map((j) => j.id).join(', ')}. The merged report above lacks their tests.`,
    );
  }
  process.exitCode = status;
}

main().catch((error) => {
  console.error(
    `test-parallel: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 2;
});
