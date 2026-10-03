#!/usr/bin/env node
/**
 * Runs a command with a deadline, so no suite can sit for ever.
 *
 *   node scripts/bounded.mjs <seconds> <command> [args...]
 *
 * Why it exists: a test run CAN hang outside any test body, where the runner's
 * own `testTimeout` and `hookTimeout` cannot reach it. One is established — on
 * Firefox, `navigator.storage.getDirectory()` inside a worker sometimes never
 * settles, and the conformance probe that calls it sits at module scope behind
 * a top-level await, so the file never starts a test and the run never ends
 * (2026-09-16, `mem:follow-ups`). That one is fixed at its source; this bound
 * is for the next one. `pnpm test:matrix` has always bounded each cell; this
 * gives `pnpm test` the same floor, which matters most in a pre-push hook or a
 * CI job, where a hang costs a whole runner rather than a terminal.
 *
 * `timeout(1)` would do it on Linux and is absent from a stock macOS, so this
 * is a script rather than a shell word.
 *
 * Exit codes: the child's own, or 124 when the deadline killed it — the same
 * code `timeout(1)` uses, and what `pnpm test:matrix` already reports.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [rawSeconds, ...command] = process.argv.slice(2);
const seconds = Number(rawSeconds);

if (!Number.isFinite(seconds) || seconds <= 0 || command.length === 0) {
  console.error(
    'usage: node scripts/bounded.mjs <seconds> <command> [args...]',
  );
  process.exit(2);
}

// Every run's output is also kept in `.test-runs/` (gitignored), the newest
// KEEP_RUNS of them: a failure seen once — in a hook, then rerun green — can
// still be read afterwards (open-retry's stall, `mem:follow-ups`). The command
// writes to a pipe rather than a terminal as a result, as it does in CI.
const KEEP_RUNS = 30;
// BOUNDED_RUNS_DIR is for this script's own unit test, whose runs must not
// push real ones out.
const runsDir =
  process.env.BOUNDED_RUNS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '.test-runs');
mkdirSync(runsDir, { recursive: true });
const label = command
  .join(' ')
  .replace(/[^\w.-]+/g, '-')
  .slice(0, 80);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log = openSync(join(runsDir, `${stamp}-${label}.log`), 'a');
writeSync(log, `$ ${command.join(' ')}\n`);
for (const old of readdirSync(runsDir)
  .filter((name) => name.endsWith('.log'))
  .sort()
  .slice(0, -KEEP_RUNS)) {
  rmSync(join(runsDir, old), { force: true });
}

/** Prints a line of this wrapper's own and keeps it in the run's log. */
const note = (line) => {
  console.error(line);
  writeSync(log, `${line}\n`);
};

/** Exits once what was written to stdout and stderr has been flushed. */
const exit = (code) => {
  writeSync(log, `[bounded] exit ${code}\n`);
  process.stdout.write('', () =>
    process.stderr.write('', () => process.exit(code)),
  );
};

// Its own process group, so that a deadline or a signal reaches what the
// command started too: `pnpm exec rstest` killed through its launcher alone
// left rstest and its browser running under init (2026-10-01). A background
// group that read the terminal would be stopped, hence no stdin. POSIX only.
const grouped = process.platform !== 'win32';

const child = spawn(command[0], command.slice(1), {
  stdio: [grouped ? 'ignore' : 'inherit', 'pipe', 'pipe'],
  detached: grouped,
  // The command comes from package.json, never from user input; no shell, so
  // an argument with a space cannot become two.
  shell: false,
});

for (const [from, to] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  from.on('data', (chunk) => {
    to.write(chunk);
    writeSync(log, chunk);
  });
}

/** Signals the command and everything it started; a group already gone is fine. */
const killAll = (signal) => {
  if (!grouped) return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
};

let killedByDeadline = false;
let forwarded = false;

const deadline = setTimeout(() => {
  killedByDeadline = true;
  note(
    `\n[bounded] \`${command.join(' ')}\` passed ${seconds}s without finishing — killing it.`,
  );
  note(
    '[bounded] A run that hangs outside a test body reports nothing by itself: read the last lines above for the file that was still running.',
  );
  killAll('SIGTERM');
  // A wedged browser process can ignore SIGTERM; do not wait for ever for it.
  setTimeout(() => killAll('SIGKILL'), 10_000).unref();
}, seconds * 1000);

// Ctrl-C and a CI cancellation must reach the child, not just this wrapper.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    forwarded = true;
    killAll(signal);
  });
}

child.on('error', (error) => {
  clearTimeout(deadline);
  note(`[bounded] could not run \`${command[0]}\`: ${error.message}`);
  exit(127);
});

let finished = false;
const finish = (code, signal) => {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  // What the command started may outlive it; a run we ended leaves nothing.
  if (killedByDeadline || forwarded) killAll('SIGKILL');
  if (killedByDeadline) return exit(124);
  if (code !== null) return exit(code);
  // Killed by a signal we did not send: report it the way a shell does.
  exit(signal === 'SIGINT' ? 130 : 1);
};

// `close` comes once the child's output has been read to the end. A process
// the command left behind may hold that output open: then `exit` decides.
child.on('close', finish);
child.on('exit', (code, signal) =>
  setTimeout(() => finish(code, signal), 2000),
);
