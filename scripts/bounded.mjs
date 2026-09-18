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

const [rawSeconds, ...command] = process.argv.slice(2);
const seconds = Number(rawSeconds);

if (!Number.isFinite(seconds) || seconds <= 0 || command.length === 0) {
  console.error(
    'usage: node scripts/bounded.mjs <seconds> <command> [args...]',
  );
  process.exit(2);
}

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  // The command comes from package.json, never from user input; no shell, so
  // an argument with a space cannot become two.
  shell: false,
});

let killedByDeadline = false;

const deadline = setTimeout(() => {
  killedByDeadline = true;
  console.error(
    `\n[bounded] \`${command.join(' ')}\` passed ${seconds}s without finishing — killing it.`,
  );
  console.error(
    '[bounded] A run that hangs outside a test body reports nothing by itself: read the last lines above for the file that was still running.',
  );
  child.kill('SIGTERM');
  // A wedged browser process can ignore SIGTERM; do not wait for ever for it.
  setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
}, seconds * 1000);

// Ctrl-C and a CI cancellation must reach the child, not just this wrapper.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  clearTimeout(deadline);
  console.error(`[bounded] could not run \`${command[0]}\`: ${error.message}`);
  process.exit(127);
});

child.on('exit', (code, signal) => {
  clearTimeout(deadline);
  if (killedByDeadline) process.exit(124);
  if (code !== null) process.exit(code);
  // Killed by a signal we did not send: report it the way a shell does.
  process.exit(signal === 'SIGINT' ? 130 : 1);
});
