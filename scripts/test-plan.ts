#!/usr/bin/env node
/**
 * The browser suite through the planner (spec 2026-10-12, § 4-5):
 *
 *   node scripts/test-plan.ts [--unit] [--browser chrome|firefox]…
 *     [--modes not-isolated,isolated] [--full] [--mode complement|all-pairs]
 *     [--pair vfs/build]… [--table] [--plan-only] [--pairs-out file] [file…]
 *
 * Probes each selected environment, parses the tests statically, plans
 * which cell runs which test, prints the plan, runs the cells
 * (`scripts/run-cell.ts`, `BSQ_TEST_JOBS` at a time, a cell cut in shards
 * by files when there are more processes than cells) and `unit`, then
 * merges their blobs as one report, followed by every test skipped with a
 * reason (`scripts/skip-notes.ts`). `--table` prints the matrix table and the
 * reasons instead, and keeps each cell's JSON report under `.matrix/<run>/` for
 * `scripts/matrix-triage.ts`. `BSQ_TEST_TARGETS` and `--pair` give the
 * pairs, never substituted. `--plan-only` stops after the plan and its checks;
 * `--pairs-out` writes the pairs that have tests. A dead test fails a run that
 * saw every pair (`scripts/plan-report.ts`).
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
import { join, relative, resolve } from 'node:path';
import type { SQLiteBuild } from '../src/const/builds.ts';
import type { SQLiteVFS } from '../src/const/vfs.ts';
import type { Family, FamilyInput, Pair, Plan } from '../tests/planner/plan.ts';
import type { BrowserName } from './browsers.ts';
import {
  allocateShards,
  type BlobState,
  buildOnce,
  findFailedJobs,
  killLiveOnSignal,
  ROOT,
  resolveConcurrency,
  runBounded,
  runPool,
} from './parallel.ts';
import {
  cellSpecs,
  collectFamily,
  loadPlanner,
  openVitest,
  type PlannedCell,
  type PlannedRun,
  probeFeatures,
} from './plan-io.ts';
import { deadIsFatal } from './plan-report.ts';
import { RECOMMENDED_VFS } from './recommended-vfs.ts';
import {
  allPairs,
  type MatrixResult,
  parseMatrixReport,
  printTable,
} from './test-matrix.ts';

const JOB_TIMEOUT_MS = 900_000;
const KEEP_RUNS = 10;
const TAIL_LINES = 60;

type Options = {
  unit: boolean;
  browsers: BrowserName[];
  isolatedModes: boolean[];
  full: boolean;
  mode: 'complement' | 'all-pairs';
  pairs: Pair[] | 'all' | null;
  table: boolean;
  /** Also write the merged report as Vitest JSON there (the coverage comparison of Task 12). */
  json: string | null;
  files: string[] | null;
  /** Plan, print and check, then exit before running anything. */
  planOnly: boolean;
  /** Write the pairs that have tests there, as a JSON array of `vfs/build`. */
  pairsOut: string | null;
};

const parsePair = (label: string): Pair => {
  const [vfs, build] = label.split('/');
  if (!vfs || !build) throw new Error(`test-plan: "${label}" is not vfs/build`);
  // Validated against the declarations by the planner (PLAN_PAIR).
  return { vfs: vfs as SQLiteVFS, build: build as SQLiteBuild };
};

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    unit: false,
    browsers: [],
    isolatedModes: [false, true],
    full: false,
    mode: 'complement',
    pairs: null,
    table: false,
    json: null,
    files: null,
    planOnly: false,
    pairsOut: null,
  };
  const pairs: Pair[] = [];
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') continue;
    if (arg === '--unit') options.unit = true;
    else if (arg === '--full') options.full = true;
    else if (arg === '--table') options.table = true;
    else if (arg === '--plan-only') options.planOnly = true;
    else if (arg === '--pairs-out') options.pairsOut = String(argv[++i]);
    else if (arg === '--json') options.json = String(argv[++i]);
    else if (arg === '--browser') {
      const browser = argv[++i];
      if (browser !== 'chrome' && browser !== 'firefox') {
        throw new Error(
          `test-plan: --browser "${browser}" is not chrome or firefox`,
        );
      }
      options.browsers.push(browser);
    } else if (arg === '--modes') {
      const modes = String(argv[++i]).split(',');
      if (modes.some((m) => m !== 'not-isolated' && m !== 'isolated')) {
        throw new Error(
          `test-plan: --modes takes not-isolated and/or isolated`,
        );
      }
      options.isolatedModes = [
        ...(modes.includes('not-isolated') ? [false] : []),
        ...(modes.includes('isolated') ? [true] : []),
      ];
    } else if (arg === '--mode') {
      const mode = argv[++i];
      if (mode !== 'complement' && mode !== 'all-pairs') {
        throw new Error(
          `test-plan: --mode "${mode}" is not complement or all-pairs`,
        );
      }
      options.mode = mode;
    } else if (arg === '--pair') pairs.push(parsePair(String(argv[++i])));
    else if (arg.startsWith('--'))
      throw new Error(`test-plan: unknown argument "${arg}"`);
    else files.push(arg);
  }
  options.browsers = options.browsers.length
    ? [...new Set(options.browsers)]
    : ['chrome', 'firefox'];
  const env = process.env.BSQ_TEST_TARGETS;
  options.pairs = pairs.length
    ? pairs
    : env === 'all'
      ? 'all'
      : env
        ? env.split(',').map((label) => parsePair(label.trim()))
        : null;
  options.files = files.length ? files : null;
  return options;
}

const describeTest = ({ file, name }: { file: string; name: string }) =>
  `${name} (${file})`;

function printPlan(plan: Plan, families: readonly FamilyInput[]) {
  console.log(`Plan: ${plan.cells.length} cells.`);
  for (const cell of plan.cells) {
    const files = new Set(cell.tests.map((t) => t.file)).size;
    console.log(
      `  ${cell.project.padEnd(44)} ${cell.reason.padEnd(10)} ${cell.tests.length} tests, ${files} files`,
    );
  }
  for (const family of families) {
    const missing = plan.notApplicable.filter(
      (u) => u.browser === family.browser && u.isolated === family.isolated,
    );
    if (missing.length === 0) continue;
    console.log(
      `Not applicable on ${family.isolated ? 'isolated ' : ''}${family.browser} (${missing.length}):`,
    );
    for (const u of missing)
      console.log(`  ${describeTest(u)} — needs [${u.tags.join(', ')}]`);
  }
  for (const n of plan.notRunnable) {
    console.log(
      `Not runnable on ${n.isolated ? 'isolated ' : ''}${n.browser}: ${n.vfs}/${n.build}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const concurrency = resolveConcurrency(process.env.BSQ_TEST_JOBS);
  const env = buildOnce(process.env);

  // --- Plan -------------------------------------------------------------
  const vitest = await openVitest();
  // A signal during planning closes this Vitest (its WebDriver processes
  // are not in `live`); the run phase's own handlers replace these.
  const closeOnSignal = (code: number) => async () => {
    await Promise.race([
      vitest.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    process.exit(code);
  };
  const planSignals = [
    ['SIGINT', closeOnSignal(130)],
    ['SIGTERM', closeOnSignal(143)],
  ] as const;
  for (const [signal, handler] of planSignals) process.on(signal, handler);
  // Closed on a refusal too: the probes leave WebDriver processes behind.
  const cells: PlannedCell[] = [];
  const families: FamilyInput[] = [];
  const matched: string[] = [];
  let plan: Plan;
  try {
    const planner = await loadPlanner(vitest);
    for (const browser of options.browsers) {
      for (const isolated of options.isolatedModes) {
        const family: Family = { browser, isolated };
        const collected = await collectFamily(vitest, family, options.files);
        matched.push(...collected.files);
        families.push({
          ...family,
          features: await probeFeatures(vitest, family),
          tests: collected.tests,
        });
      }
    }
    // A typo would otherwise plan zero cells and pass.
    const unknown = (options.files ?? []).filter(
      (file) => !matched.includes(relative(ROOT, resolve(ROOT, file))),
    );
    if (unknown.length > 0) {
      for (const file of unknown) {
        console.error(
          `test-plan: ${file} is not a test file of the selected projects`,
        );
      }
      process.exitCode = 2;
      return;
    }
    plan = planner.plan(families, {
      mode: options.mode,
      fullIsolation: options.full,
      recommended: RECOMMENDED_VFS,
      pairs: options.pairs,
    });
    for (const cell of plan.cells) {
      const features = families.find(
        (f) => f.browser === cell.browser && f.isolated === cell.isolated,
      )?.features as PlannedCell['features'];
      cells.push({
        project: cell.project,
        vfs: cell.vfs,
        build: cell.build,
        features,
        specs: await cellSpecs(vitest, cell),
      });
    }
  } finally {
    for (const [signal, handler] of planSignals) process.off(signal, handler);
    await vitest.close();
  }
  killLiveOnSignal();
  printPlan(plan, families);

  const allNotRunnable =
    Array.isArray(options.pairs) &&
    options.pairs.some((pair) =>
      families.every((f) =>
        plan.notRunnable.some(
          (n) =>
            n.browser === f.browser &&
            n.isolated === f.isolated &&
            n.vfs === pair.vfs &&
            n.build === pair.build,
        ),
      ),
    );
  if (allNotRunnable) {
    console.error(
      'test-plan: an explicit pair runs on no selected browser (above)',
    );
    process.exitCode = 1;
    return;
  }

  // Dead fails CI and the matrix; locally a browser may simply be absent.
  let status = 0;
  let deadFatal = false;
  if (plan.dead.length > 0) {
    const fatal = deadIsFatal(
      {
        mode: options.mode,
        explicitPairs: Array.isArray(options.pairs),
        browsers: options.browsers.length,
        modes: options.isolatedModes.length,
      },
      process.env.CI === 'true',
    );
    console[fatal ? 'error' : 'warn'](
      `\n${plan.dead.length} test(s) run on no pair of any selected browser:\n${plan.dead.map((d) => `  ${describeTest(d)} — needs [${d.tags.join(', ')}]`).join('\n')}`,
    );
    if (fatal) status = 1;
    deadFatal = fatal;
  }
  if (options.pairsOut) {
    const withTests = new Set(plan.cells.map((c) => `${c.vfs}/${c.build}`));
    const nonEmptyPairs = allPairs()
      .map((p) => `${p.vfs}/${p.build}`)
      .filter((label) => withTests.has(label));
    writeFileSync(options.pairsOut, JSON.stringify(nonEmptyPairs));
  }
  if (options.planOnly) {
    process.exitCode = status;
    return;
  }

  // --- Run --------------------------------------------------------------
  const runsRoot = join(ROOT, options.table ? '.matrix' : '.test-parallel');
  const run = join(runsRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  const blobs = join(run, 'blobs');
  const logs = join(run, 'logs');
  const reports = options.table ? run : join(run, 'reports');
  for (const dir of [blobs, logs, reports]) mkdirSync(dir, { recursive: true });
  // The matrix keeps every report: scripts/test-matrix.ts never deleted any.
  if (!options.table) {
    for (const old of readdirSync(runsRoot).sort().slice(0, -KEEP_RUNS)) {
      rmSync(join(runsRoot, old), { recursive: true, force: true });
    }
  }
  // Under logs/: matrix-triage reads every *.json beside the table's reports.
  const planFile = join(logs, 'plan.json');
  const planned: PlannedRun = { fullIsolation: options.full, cells };
  writeFileSync(planFile, JSON.stringify(planned, null, 2));

  // The matrix keeps one report per cell; elsewhere a cell may be sharded.
  const shards = options.table
    ? cells.map(() => 1)
    : allocateShards(
        cells.map((c) => ({ name: c.project, files: c.specs.length })),
        concurrency,
      ).map((s) => s.shards);
  // `isolated chrome · OPFSWriteAheadVFS/sync` → `isolated-chrome__OPFSWriteAheadVFS__sync`,
  // the name scripts/matrix-triage.ts parses.
  const slug = (name: string) =>
    name.replace(/ · /g, '__').replace(/\//g, '__').replace(/ /g, '-');
  type Job = { id: string; cell: number | null; shard: number; shards: number };
  const jobs: Job[] = [
    ...(options.unit ? [{ id: 'unit', cell: null, shard: 1, shards: 1 }] : []),
    ...cells.flatMap((cell, index) =>
      Array.from({ length: shards[index] as number }, (_, s) => ({
        id:
          (shards[index] as number) > 1
            ? `${slug(cell.project)}.${s + 1}of${shards[index]}`
            : slug(cell.project),
        cell: index,
        shard: s + 1,
        shards: shards[index] as number,
      })),
    ),
  ];
  console.log(
    `\n${jobs.length} jobs, ${concurrency} at a time. Run under ${relative(ROOT, run)}.`,
  );

  const start = Date.now();
  let done = 0;
  const results = new Map<string, MatrixResult>();
  const settled = await runPool(jobs, concurrency, async (job) => {
    const blob = join(blobs, `${job.id}.json`);
    const json = join(reports, `${job.id}.json`);
    const began = Date.now();
    const { output, timedOut, exitCode, error } =
      job.cell === null
        ? await runBounded(
            'pnpm',
            [
              'exec',
              'vitest',
              'run',
              '--configLoader',
              'runner',
              '--project',
              'unit',
              '--reporter=blob',
              `--outputFile=${blob}`,
            ],
            { cwd: ROOT, env, timeoutMs: JOB_TIMEOUT_MS },
          )
        : await runBounded(
            'node',
            [
              'scripts/run-cell.ts',
              planFile,
              String(job.cell),
              String(job.shard),
              String(job.shards),
              blob,
              json,
            ],
            { cwd: ROOT, env, timeoutMs: JOB_TIMEOUT_MS },
          );
    writeFileSync(
      join(logs, `${job.id}.log`),
      error ? `${output}\n${error.message}\n` : output,
    );
    let state: BlobState = existsSync(blob) ? 'ok' : 'missing';
    if (state === 'ok') {
      try {
        JSON.parse(readFileSync(blob, 'utf8'));
      } catch {
        state = 'unparsable';
        rmSync(blob);
      }
    }
    if (job.cell !== null && options.table) {
      const cell = cells[job.cell] as PlannedCell;
      results.set(
        cell.project,
        timedOut
          ? { status: 'timed-out' }
          : error
            ? { status: 'error', message: error.message }
            : parseMatrixReport(
                existsSync(json) ? readFileSync(json, 'utf8') : '',
              ),
      );
    }
    const ended = timedOut
      ? 'timed out'
      : error
        ? `error ${error.message}`
        : `exit ${exitCode}`;
    console.log(
      `[${++done}/${jobs.length}] ${job.id}: ${ended} in ${Math.round((Date.now() - began) / 1000)}s${state === 'ok' ? '' : ' (NO BLOB)'}`,
    );
    return { job, timedOut, error, blob: state, exitCode };
  });
  const outcomes = settled.map((o, i) =>
    o.status === 'fulfilled'
      ? o.value
      : {
          job: jobs[i] as Job,
          timedOut: false,
          error:
            o.reason instanceof Error ? o.reason : new Error(String(o.reason)),
          blob: 'missing' as BlobState,
          exitCode: null,
        },
  );
  const failed = findFailedJobs(outcomes);
  console.log(`Jobs done in ${Math.round((Date.now() - start) / 1000)}s.\n`);

  if (failed.length > 0 || outcomes.some((o) => o.exitCode !== 0)) status = 1;
  // The default reporter shows a skip's reason only on a failed module's lines.
  const SKIP_NOTES = '--reporter=./scripts/skip-notes.ts';
  const mergeBlobs = (reporters: string[]) =>
    spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        '--configLoader',
        'runner',
        '--merge-reports',
        blobs,
        ...reporters,
      ],
      { cwd: ROOT, env, stdio: 'inherit' },
    );
  if (options.table) {
    const columns = ['chrome', 'firefox', 'isolated-chrome', 'isolated-firefox']
      .filter((name) =>
        families.some(
          (f) => (f.isolated ? `isolated-${f.browser}` : f.browser) === name,
        ),
      )
      .map((name) => ({ name, args: [] as string[] }));
    const pairs = [
      ...new Map(
        cells.map((c) => [
          `${c.vfs}/${c.build}`,
          { vfs: c.vfs, build: c.build },
        ]),
      ).values(),
    ];
    const keyed = new Map<string, MatrixResult>();
    for (const cell of cells) {
      const column = cell.project.startsWith('isolated ')
        ? `isolated-${cell.project.split(' ')[1]}`
        : cell.project.split(' ')[0];
      const result = results.get(cell.project);
      if (result) keyed.set(`${column}:${cell.vfs}/${cell.build}`, result);
    }
    printTable(pairs, columns, keyed);
    // The table decides the status; this merge only prints the reasons.
    if (outcomes.some((o) => o.blob === 'ok')) mergeBlobs([SKIP_NOTES]);
  } else if (outcomes.some((o) => o.blob === 'ok')) {
    const merged = mergeBlobs([
      '--reporter=default',
      SKIP_NOTES,
      ...(options.json
        ? ['--reporter=json', `--outputFile=${options.json}`]
        : []),
    ]);
    if (merged.status !== 0) status = 1;
  }
  // A cell that ran and failed leaves a complete blob, so it is not in `failed`;
  // its log (the default reporter's output) is what says why, in a CI job log too.
  const red = [...failed];
  for (const { job, exitCode } of outcomes) {
    if (red.some((r) => r.job === job)) continue;
    const result =
      job.cell === null || !options.table
        ? undefined
        : results.get((cells[job.cell] as PlannedCell).project);
    const unwell = result !== undefined && result.status !== 'passed';
    if (exitCode !== 0 || unwell) {
      red.push({
        job,
        reason: exitCode !== 0 ? `exit ${exitCode}` : 'red cell',
      });
    }
  }
  for (const { job, reason } of red) {
    const log = join(logs, `${job.id}.log`);
    const tail = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').slice(-TAIL_LINES).join('\n')
      : '(no log)';
    console.error(
      `\n--- ${job.id} failed (${reason}); last ${TAIL_LINES} lines of ${log} ---\n${tail}\n--- end ---`,
    );
  }
  // The dead report is above the run; say here why the exit is 1 when every cell is green.
  if (deadFatal) {
    console.error(
      `test-plan: failing because ${plan.dead.length} test(s) run on no pair (listed after the plan, above)`,
    );
  }
  process.exitCode = status;
}

main().catch((error) => {
  console.error(`test-plan: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 2;
});
