#!/usr/bin/env node
/**
 * `pnpm test:matrix` — runs the browser suite on every declared (vfs, build)
 * pair, on every engine column, sequentially, and prints a pair × engine
 * table (spec 2026-09-15, A5 §12).
 *
 * Columns are the three rstest configs that follow a target
 * (`tests/target-projects.ts`): `rstest.config.ts` (Chromium — run with
 * `--project 'chromium*'`, since rstest's project filter is anchored and the
 * config also declares the non-target `unit` project), `rstest.firefox.config.ts`
 * and `rstest.isolated.config.ts` (cross-origin isolated Chromium).
 *
 * Each cell is one `pnpm exec rstest --config <cfg> run` with
 * `BSQ_TEST_TARGETS=<vfs>/<build>` in the environment, which makes that config
 * build exactly one project for that pair. Raw output is kept under
 * `.matrix/<run>/<engine>-<vfs>-<build>.txt` (gitignored) for later reading;
 * the table only shows the parsed summary.
 *
 * A run is bounded by a timer this script owns (`child_process.spawn` plus a
 * `setTimeout` that kills the whole process group), not by the shell `timeout`
 * binary — a Firefox run hung silently (0% CPU, no output) during this work,
 * and a script relying on `timeout` being on PATH would have no such guard on
 * a machine without it. A run this bound kills is reported as "timed out",
 * never as a hang.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VFS_CAPABILITIES } from '../src/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** One column of the matrix: which config to run and how to select it. */
const ENGINES = [
  { name: 'chromium', config: 'rstest.config.ts', extraArgs: ['--project', 'chromium*'] },
  { name: 'firefox', config: 'rstest.firefox.config.ts', extraArgs: [] },
  { name: 'isolated', config: 'rstest.isolated.config.ts', extraArgs: [] },
];

/** Matches Task 10's brief: `timeout 600` per run, owned in-process instead. */
const RUN_TIMEOUT_MS = 600_000;

/** Every declared (vfs, build) pair, in `VFS_CAPABILITIES` key order. */
export const allPairs = () =>
  Object.entries(VFS_CAPABILITIES).flatMap(([vfs, cap]) =>
    cap.builds.map((build) => ({ vfs, build })),
  );

/**
 * Parses one rstest 0.11.8 markdown report into a matrix cell.
 *
 * rstest prints a `## Summary` section holding a fenced ```json block first
 * — `status`, `counts` and `durationMs.total` — followed by a `## Failures`
 * section listing each failure's `errors[].message`. This function reads
 * only those two things and nothing else about the report's layout.
 *
 * - No ```json block at all: the run never got to print a report — killed by
 *   this script's own timer, or crashed before finishing a build. Reported
 *   `timed-out`, since a genuinely killed run is exactly what looks like this.
 * - A failing summary whose failures are ALL `TARGET_NOT_RUNNABLE` (thrown by
 *   `createTestClient` when the target lacks a feature this browser doesn't
 *   have): `not-runnable`, not a failure — this browser was never able to run
 *   the pair.
 * - Anything else failing: `failed`, even where some failures are
 *   `TARGET_NOT_RUNNABLE` and others are not — a mix means a real failure is
 *   present, and `not-runnable` must never hide one.
 * - Otherwise: `passed`.
 *
 * @param {string} output combined stdout+stderr of one rstest run.
 */
export function parseMatrixReport(output) {
  const summaryMatch = output.match(/```json\n([\s\S]*?)\n```/);
  if (!summaryMatch) {
    return { status: 'timed-out' };
  }
  const summary = JSON.parse(summaryMatch[1]);
  const seconds = Math.round(summary.durationMs.total / 1000);

  if (summary.status === 'fail') {
    const failuresIndex = output.indexOf('## Failures');
    const failuresSection = failuresIndex === -1 ? '' : output.slice(failuresIndex);
    const messages = [...failuresSection.matchAll(/"message":\s*"((?:\\.|[^"\\])*)"/g)].map(
      (m) => JSON.parse(`"${m[1]}"`),
    );
    if (messages.length > 0 && messages.every((m) => m.startsWith('TARGET_NOT_RUNNABLE'))) {
      return { status: 'not-runnable', seconds };
    }
  }

  return {
    status: summary.status === 'pass' ? 'passed' : 'failed',
    tests: summary.counts.tests,
    passed: summary.counts.passedTests,
    failed: summary.counts.failedTests,
    skipped: summary.counts.skippedTests,
    seconds,
  };
}

/** `--engine <name>` (repeatable) and `--pair <vfs>/<build>` (repeatable). */
function parseArgs(argv) {
  const engines = [];
  const pairs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--engine') {
      const name = argv[++i];
      if (!ENGINES.some((e) => e.name === name)) {
        throw new Error(
          `test-matrix: --engine "${name}" is not one of ${ENGINES.map((e) => e.name).join(', ')}`,
        );
      }
      engines.push(name);
    } else if (arg === '--pair') {
      const label = argv[++i];
      const [vfs, build] = String(label).split('/');
      if (!vfs || !build || !Object.hasOwn(VFS_CAPABILITIES, vfs) || !VFS_CAPABILITIES[vfs].builds.includes(build)) {
        throw new Error(`test-matrix: --pair "${label}" is not a declared vfs/build pair`);
      }
      pairs.push({ vfs, build });
    } else {
      throw new Error(`test-matrix: unknown argument "${arg}"`);
    }
  }
  return {
    engines: engines.length ? ENGINES.filter((e) => engines.includes(e.name)) : ENGINES,
    pairs: pairs.length ? pairs : allPairs(),
  };
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
 *   pattern `scripts/consumer-smoke.mjs` uses, because `pnpm exec rstest`
 *   forks the actual Playwright-driven runner and browser, which survive
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
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number }} options
 */
export function runBounded(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      output += String(d);
    });
    child.stderr?.on('data', (d) => {
      output += String(d);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, timedOut, error });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output, timedOut, error: null });
    });
  });
}

/** Runs one (engine, pair) cell via `runBounded`, translating its result into a matrix cell. */
function runOne(engine, pair, outFile) {
  const args = ['exec', 'rstest', '--config', engine.config, ...engine.extraArgs, 'run'];
  return runBounded('pnpm', args, {
    cwd: ROOT,
    env: { ...process.env, BSQ_TEST_TARGETS: `${pair.vfs}/${pair.build}` },
    timeoutMs: RUN_TIMEOUT_MS,
  }).then(({ output, timedOut, error }) => {
    writeFileSync(outFile, output);
    if (error) return { status: 'error', message: error.message };
    return timedOut ? { status: 'timed-out' } : parseMatrixReport(output);
  });
}

/** `522/0/4 · 52s`, or the status word for a cell that never produced counts. */
function formatCell(result) {
  if (result.status === 'not-runnable') return 'not runnable here';
  if (result.status === 'timed-out') return 'timed out';
  if (result.status === 'error') return `error: ${result.message}`;
  return `${result.passed}/${result.failed}/${result.skipped} · ${result.seconds}s`;
}

function printTable(pairs, engines, results) {
  const pairLabel = ({ vfs, build }) => `${vfs}/${build}`;
  const header = ['pair', ...engines.map((e) => e.name)];
  const rows = pairs.map((pair) => [
    pairLabel(pair),
    ...engines.map((engine) => formatCell(results.get(`${engine.name}:${pairLabel(pair)}`))),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}

async function main() {
  const { engines, pairs } = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(ROOT, '.matrix', runId);
  mkdirSync(runDir, { recursive: true });

  const results = new Map();
  const start = Date.now();
  for (const engine of engines) {
    for (const pair of pairs) {
      const label = `${pair.vfs}/${pair.build}`;
      const outFile = join(runDir, `${engine.name}-${pair.vfs}-${pair.build}.txt`);
      process.stdout.write(`[${engine.name}] ${label}: running…\n`);
      const result = await runOne(engine, pair, outFile);
      results.set(`${engine.name}:${label}`, result);
      process.stdout.write(`[${engine.name}] ${label}: ${formatCell(result)}\n`);
    }
  }

  console.log('');
  printTable(pairs, engines, results);
  const totalSeconds = Math.round((Date.now() - start) / 1000);
  console.log('');
  console.log(`Total: ${totalSeconds}s. Reports under ${join('.matrix', runId)}.`);

  const failed = [...results.values()].some(
    (r) => r.status === 'failed' || r.status === 'timed-out' || r.status === 'error',
  );
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
