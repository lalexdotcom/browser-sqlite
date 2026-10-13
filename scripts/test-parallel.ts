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
 * `BSQ_TEST_JOBS` processes (default: every CPU but one, at most 6) run at
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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type BlobState,
  buildOnce,
  findFailedJobs,
  jobEnv,
  killLiveOnSignal,
  matchProjects,
  planJobs,
  ROOT,
  resolveConcurrency,
  runBounded,
  runPool,
} from './parallel.ts';

/** Each job is bounded by a timer this script owns, as a matrix cell is. */
const JOB_TIMEOUT_MS = 900_000;
const KEEP_RUNS = 10;
const TAIL_LINES = 60;

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

/** `ok` when the file is there and parses: Vitest writes a blob as JSON. */
function blobState(file: string): BlobState {
  if (!existsSync(file)) return 'missing';
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return 'ok';
  } catch {
    return 'unparsable';
  }
}

const tailOf = (file: string) =>
  readFileSync(file, 'utf8').split('\n').slice(-TAIL_LINES).join('\n');

async function main() {
  const { globs, mergeArgs } = parseArgs(process.argv.slice(2));
  const concurrency = resolveConcurrency(process.env.BSQ_TEST_JOBS);
  // `vitest list` needs no build: a typo in a glob fails before the build.
  const projects = listProjects({ ...process.env, BSQ_TEST_BUILT: '1' });
  const names = matchProjects(globs, [...projects.keys()]);
  const jobs = planJobs(projects, names, concurrency);
  const env = buildOnce(process.env);
  killLiveOnSignal();

  const runsRoot = join(ROOT, '.test-parallel');
  const run = join(runsRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const blobs = join(run, 'blobs');
  const logs = join(run, 'logs');
  // Blobs the merge cannot read, moved out of its directory.
  const rejected = join(run, 'rejected');
  mkdirSync(blobs, { recursive: true });
  mkdirSync(logs, { recursive: true });
  mkdirSync(rejected, { recursive: true });
  for (const old of readdirSync(runsRoot).sort().slice(0, -KEEP_RUNS)) {
    rmSync(join(runsRoot, old), { recursive: true, force: true });
  }
  console.log(
    `${jobs.length} jobs, ${concurrency} at a time. Run under ${run}.`,
  );

  const start = Date.now();
  let done = 0;
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
      { cwd: ROOT, env: jobEnv(env, job.id), timeoutMs: JOB_TIMEOUT_MS },
    );
    writeFileSync(log, error ? `${output}\n${error.message}\n` : output);
    const state = blobState(blob);
    // A blob the merge cannot read would kill it without naming the job.
    if (state === 'unparsable')
      renameSync(blob, join(rejected, `${job.id}.json`));
    const ended = timedOut
      ? 'timed out'
      : error
        ? `error ${error.message}`
        : `exit ${exitCode}`;
    console.log(
      `[${++done}/${jobs.length}] ${job.id}: ${ended} in ${Math.round((Date.now() - began) / 1000)}s${state === 'ok' ? '' : ` (${state === 'missing' ? 'NO BLOB' : 'BLOB DOES NOT PARSE'})`}`,
    );
    return { job, timedOut, error, blob: state };
  });
  const failed = findFailedJobs(
    settled.flatMap((outcome, i) => {
      if (outcome.status === 'fulfilled') return [outcome.value];
      console.error(`${jobs[i].id}: ${String(outcome.reason)}`);
      return [
        {
          job: jobs[i],
          timedOut: false,
          error:
            outcome.reason instanceof Error
              ? outcome.reason
              : new Error(String(outcome.reason)),
          blob: 'missing' as BlobState,
        },
      ];
    }),
  );
  const usable = settled.filter(
    (o) => o.status === 'fulfilled' && o.value.blob === 'ok',
  ).length;
  console.log(
    `Jobs done in ${Math.round((Date.now() - start) / 1000)}s. Merging…\n`,
  );

  let status = failed.length > 0 ? 1 : 0;
  if (usable > 0) {
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
  for (const { job, reason } of failed) {
    const log = join(logs, `${job.id}.log`);
    console.error(
      `\n--- ${job.id} failed (${reason}); last ${TAIL_LINES} lines of ${log} ---\n${existsSync(log) ? tailOf(log) : '(no log)'}\n--- end ---`,
    );
  }
  if (failed.length > 0) {
    console.error(
      `\n${failed.length} of ${jobs.length} jobs did not finish cleanly: ${failed.map((f) => `${f.job.id} (${f.reason})`).join(', ')}. The merged report above may lack their tests.`,
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
