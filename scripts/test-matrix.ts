#!/usr/bin/env node
/**
 * `pnpm test:matrix` — runs the browser suite on every declared (vfs, build)
 * pair, on every column, and prints a pair × column table
 * (spec 2026-09-15, A5 §12).
 *
 * A column is a browser in a mode (`vitest.config.ts`): `chrome`, `firefox`,
 * `isolated-chrome` (cross-origin isolated) and `isolated-firefox`.
 *
 * Since the test planner (spec 2026-10-12), a run is `scripts/test-plan.ts --mode all-pairs --table`: only the cells with tests to run start, each with exactly its tests, and the table shows a cell that did not start as —. Each cell leaves `<column>__<vfs>__<build>.json` (Vitest's JSON report) under `.matrix/<run>/`, which `scripts/matrix-triage.ts` reads, and its console (Vitest's default reporter) under `.matrix/<run>/logs/`; the tail of a red cell's log is printed.
 */
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../src/const/vfs.ts';
import { ROOT } from './parallel.ts';

/** One column of the matrix, named `<browser>` or `isolated-<browser>`; `args` is no longer read (the planner selects the projects). */
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
  | { readonly status: 'timed-out' }
  | { readonly status: 'error'; readonly message: string };

export const COLUMNS: Column[] = [
  { name: 'chrome', args: ['--project', 'chrome ·*'] },
  { name: 'firefox', args: ['--project', 'firefox ·*'] },
  { name: 'isolated-chrome', args: ['--project', 'isolated chrome ·*'] },
  { name: 'isolated-firefox', args: ['--project', 'isolated firefox ·*'] },
];

/** Every declared (vfs, build) pair, in `VFS_CAPABILITIES` key order. */
export const allPairs = (): Pair[] =>
  Object.entries(VFS_CAPABILITIES).flatMap(([vfs, cap]) =>
    cap.builds.map((build) => ({ vfs, build })),
  );

/**
 * Reads one Vitest JSON report (`--reporter=json --outputFile`) into a matrix
 * cell. No report, or one that does not parse: the run never finished —
 * killed by the planner's timer or crashed first — so `timed-out`.
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
  const unhandled = report.testResults
    .filter((f) => f.status === 'failed' && f.message)
    // `/` on every OS: a table read beside Linux's, and greppable the same way.
    .map(
      (f) => `${relative(ROOT, f.name).replaceAll('\\', '/')}: ${f.message}`,
    );
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

/**
 * `522/0/4 · 57 files · 52s`, or the status word for a cell that never
 * produced counts. A failed cell with no failed test says FAIL and why, or its
 * counts read as green — a page crash looks exactly like that.
 */
export function formatCell(result: MatrixResult | undefined): string {
  if (result === undefined) return '—';
  if (result.status === 'timed-out') return 'timed out';
  if (result.status === 'error') return `error: ${result.message}`;
  const cell = `${result.passed}/${result.failed}/${result.skipped} · ${result.files} files · ${result.seconds}s`;
  if (result.status !== 'failed' || result.failed > 0) return cell;
  return `${cell} · FAIL: ${result.unhandled?.[0] ?? 'the report says fail'}`;
}

export function printTable(
  pairs: Pair[],
  columns: Column[],
  results: Map<string, MatrixResult>,
) {
  const pairLabel = ({ vfs, build }: Pair) => `${vfs}/${build}`;
  const header = ['pair', ...columns.map((c) => c.name)];
  const rows = pairs.map((pair) => [
    pairLabel(pair),
    ...columns.map((column) =>
      formatCell(results.get(`${column.name}:${pairLabel(pair)}`)),
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
  const browsers = [
    ...new Set(columns.map((c) => c.name.replace('isolated-', ''))),
  ];
  const modes = [
    ...new Set(
      columns.map((c) =>
        c.name.startsWith('isolated-') ? 'isolated' : 'not-isolated',
      ),
    ),
  ];
  // The plan selects browsers × modes: a mix such as chrome with isolated-firefox is not one.
  if (browsers.length * modes.length !== columns.length) {
    throw new Error(
      `test-matrix: --engine ${columns.map((c) => c.name).join(', ')} is not a product of browsers and modes`,
    );
  }
  const explicit = process.argv.includes('--pair');
  const run = spawnSync(
    'node',
    [
      'scripts/test-plan.ts',
      '--mode',
      'all-pairs',
      '--table',
      ...browsers.flatMap((b) => ['--browser', b]),
      '--modes',
      modes.join(','),
      ...(explicit
        ? pairs.flatMap((p) => ['--pair', `${p.vfs}/${p.build}`])
        : []),
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  process.exitCode = run.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
