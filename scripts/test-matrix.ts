#!/usr/bin/env node
/**
 * `pnpm test:matrix` — runs the browser suite on every declared (vfs, build)
 * pair, on every column, sequentially, and prints a pair × column table
 * (spec 2026-09-15, A5 §12).
 *
 * A column is a family of Vitest projects that follow a target
 * (`vitest.config.ts`): `chrome`, `firefox`, `isolated-chrome` (cross-origin
 * isolated) and `isolated-firefox`, each selected by a `--project` glob.
 *
 * Each cell is one `pnpm exec vitest run` with `BSQ_TEST_TARGETS=<vfs>/<build>`
 * in the environment, which makes the config declare exactly one project per
 * column for that pair, and `BSQ_TEST_NEEDS=skip`, so that every test the cell
 * reports ran on that pair. A cell leaves `<column>__<vfs>__<build>.json`
 * (Vitest's JSON report, which the table is parsed from) and `.log` (the
 * console) under `.matrix/<run>/` (gitignored).
 *
 * A run is bounded by a timer this script owns (`child_process.spawn` plus a
 * `setTimeout` that kills the whole process group), not by the shell `timeout`
 * binary — a Firefox run hung silently (0% CPU, no output) during this work,
 * and a script relying on `timeout` being on PATH would have no such guard on
 * a machine without it. A run this bound kills is reported as "timed out",
 * never as a hang.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../src/const/vfs.ts';
import { ROOT, runBounded } from './parallel.ts';

/** One column of the matrix: the `--project` glob that selects its projects. */
type Column = { name: string; args: string[] };
type Pair = { vfs: string; build: string };

export type MatrixResult =
  | {
      readonly status: 'passed' | 'failed';
      readonly tests: number;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
      readonly files: number;
      readonly seconds: number;
      /** Files that failed with no failed test, `path: reason`; absent when none. */
      readonly unhandled?: readonly string[];
    }
  | { readonly status: 'not-runnable'; readonly seconds: number }
  | { readonly status: 'timed-out' }
  | { readonly status: 'error'; readonly message: string };

export const COLUMNS: Column[] = [
  { name: 'chrome', args: ['--project', 'chrome ·*'] },
  { name: 'firefox', args: ['--project', 'firefox ·*'] },
  { name: 'isolated-chrome', args: ['--project', 'isolated chrome ·*'] },
  { name: 'isolated-firefox', args: ['--project', 'isolated firefox ·*'] },
];

/** Each cell is bounded at 600 s by a timer this script owns. */
const RUN_TIMEOUT_MS = 600_000;

/** Enough of a failing run's tail to name the cause; short enough to read in a job log. */
const TAIL_LINES = 60;

/** Every declared (vfs, build) pair, in `VFS_CAPABILITIES` key order. */
export const allPairs = (): Pair[] =>
  Object.entries(VFS_CAPABILITIES).flatMap(([vfs, cap]) =>
    cap.builds.map((build) => ({ vfs, build })),
  );

/**
 * Reads one Vitest JSON report (`--reporter=json --outputFile`) into a matrix
 * cell. No report, or one that does not parse: the run never finished —
 * killed by this script's timer or crashed first — so `timed-out`. Failures
 * that are ALL `TARGET_NOT_RUNNABLE`: `not-runnable`, never hiding a real one.
 * A file that failed with no failed test (a page crash) carries its reason in
 * `message`: reported in `unhandled`, so the cell reads FAIL with that reason.
 */
export function parseMatrixReport(json: string): MatrixResult {
  let report: VitestReport;
  try {
    report = JSON.parse(json);
  } catch {
    return { status: 'timed-out' };
  }
  if (!Array.isArray(report?.testResults)) return { status: 'timed-out' };
  const tests = report.testResults.flatMap((f) => f.assertionResults);
  const failures = tests.filter((t) => t.status === 'failed');
  const end = Math.max(
    report.startTime,
    ...report.testResults.map((f) => f.endTime),
  );
  const seconds = Math.round((end - report.startTime) / 1000);
  const messages = failures.flatMap((t) => t.failureMessages);
  const unhandled = report.testResults
    .filter((f) => f.status === 'failed' && f.message)
    .map((f) => `${relative(ROOT, f.name)}: ${f.message}`);
  // A file-level failure is never hidden behind not-runnable tests.
  if (
    unhandled.length === 0 &&
    messages.length > 0 &&
    messages.every((m) => m.startsWith('TARGET_NOT_RUNNABLE'))
  ) {
    return { status: 'not-runnable', seconds };
  }
  return {
    status: report.success ? 'passed' : 'failed',
    tests: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: failures.length,
    skipped: tests.filter(
      (t) =>
        t.status === 'skipped' || t.status === 'pending' || t.status === 'todo',
    ).length,
    files: report.testResults.length,
    seconds,
    ...(unhandled.length > 0 ? { unhandled } : {}),
  };
}

type VitestReport = {
  success: boolean;
  startTime: number;
  testResults: {
    name: string;
    status: string;
    message: string;
    endTime: number;
    assertionResults: { status: string; failureMessages: string[] }[];
  }[];
};

/** `--engine <column>` (repeatable) and `--pair <vfs>/<build>` (repeatable). */
function parseArgs(argv: string[]) {
  const names: string[] = [];
  const pairs: Pair[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--engine') {
      const name = argv[++i];
      if (!COLUMNS.some((c) => c.name === name)) {
        throw new Error(
          `test-matrix: --engine "${name}" is not one of ${COLUMNS.map((c) => c.name).join(', ')}`,
        );
      }
      names.push(name);
    } else if (arg === '--pair') {
      const label = argv[++i];
      const [vfs, build] = String(label).split('/');
      if (
        !vfs ||
        !build ||
        !Object.hasOwn(VFS_CAPABILITIES, vfs) ||
        !(
          VFS_CAPABILITIES[vfs as SQLiteVFS].builds as readonly string[]
        ).includes(build)
      ) {
        throw new Error(
          `test-matrix: --pair "${label}" is not a declared vfs/build pair`,
        );
      }
      pairs.push({ vfs, build });
    } else {
      throw new Error(`test-matrix: unknown argument "${arg}"`);
    }
  }
  return {
    columns: names.length
      ? COLUMNS.filter((c) => names.includes(c.name))
      : COLUMNS,
    pairs: pairs.length ? pairs : allPairs(),
  };
}

/** Runs one (column, pair) cell via `runBounded`, translating its result into a matrix cell. */
function runOne(
  column: Column,
  pair: Pair,
  cellBase: string,
): Promise<MatrixResult> {
  const reportFile = `${cellBase}.json`;
  const args = [
    'exec',
    'vitest',
    'run',
    '--configLoader',
    'runner',
    ...column.args,
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${reportFile}`,
  ];
  return runBounded('pnpm', args, {
    cwd: ROOT,
    // `skip`: a test whose need this pair lacks is skipped rather than run on
    // another pair, which is a cell of its own (spec 2026-09-15, A7).
    env: {
      ...process.env,
      BSQ_TEST_TARGETS: `${pair.vfs}/${pair.build}`,
      BSQ_TEST_NEEDS: 'skip',
    },
    timeoutMs: RUN_TIMEOUT_MS,
  }).then(({ output, timedOut, error }) => {
    writeFileSync(`${cellBase}.log`, output);
    if (error) return { status: 'error', message: error.message };
    if (timedOut) return { status: 'timed-out' };
    return parseMatrixReport(
      existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '',
    );
  });
}

/**
 * `522/0/4 · 57 files · 52s`, or the status word for a cell that never
 * produced counts. A failed cell with no failed test says FAIL and why, or its
 * counts read as green — a page crash looks exactly like that.
 */
export function formatCell(result: MatrixResult): string {
  if (result.status === 'not-runnable') return 'not runnable here';
  if (result.status === 'timed-out') return 'timed out';
  if (result.status === 'error') return `error: ${result.message}`;
  const cell = `${result.passed}/${result.failed}/${result.skipped} · ${result.files} files · ${result.seconds}s`;
  if (result.status !== 'failed' || result.failed > 0) return cell;
  return `${cell} · FAIL: ${result.unhandled?.[0] ?? 'the report says fail'}`;
}

function printTable(
  pairs: Pair[],
  columns: Column[],
  results: Map<string, MatrixResult>,
) {
  const pairLabel = ({ vfs, build }: Pair) => `${vfs}/${build}`;
  const header = ['pair', ...columns.map((c) => c.name)];
  const rows = pairs.map((pair) => [
    pairLabel(pair),
    ...columns.map((column) =>
      formatCell(
        results.get(`${column.name}:${pairLabel(pair)}`) as MatrixResult,
      ),
    ),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

async function main() {
  const { columns, pairs } = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(ROOT, '.matrix', runId);
  mkdirSync(runDir, { recursive: true });

  const results = new Map<string, MatrixResult>();
  const start = Date.now();
  for (const column of columns) {
    for (const pair of pairs) {
      const label = `${pair.vfs}/${pair.build}`;
      const cellBase = join(
        runDir,
        `${column.name}__${pair.vfs}__${pair.build}`,
      );
      process.stdout.write(`[${column.name}] ${label}: running…\n`);
      const result = await runOne(column, pair, cellBase);
      results.set(`${column.name}:${label}`, result);
      process.stdout.write(
        `[${column.name}] ${label}: ${formatCell(result)}\n`,
      );
      // A verdict alone cannot be diagnosed anywhere the report files do not
      // survive the machine, which is every CI runner. "timed out" especially:
      // it is also what a run that never wrote a report looks like.
      if (result.status !== 'passed' && result.status !== 'not-runnable') {
        const tail = readFileSync(`${cellBase}.log`, 'utf8')
          .split('\n')
          .slice(-TAIL_LINES);
        process.stdout.write(
          `--- ${column.name} ${label}: last ${tail.length} lines ---\n${tail.join('\n')}\n--- end ---\n`,
        );
      }
    }
  }

  console.log('');
  printTable(pairs, columns, results);
  const totalSeconds = Math.round((Date.now() - start) / 1000);
  console.log('');
  console.log(
    `Total: ${totalSeconds}s. Reports under ${join('.matrix', runId)}.`,
  );

  const failed = [...results.values()].some(
    (r) =>
      r.status === 'failed' || r.status === 'timed-out' || r.status === 'error',
  );
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
