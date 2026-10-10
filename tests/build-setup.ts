import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD = ['exec', 'rslib', 'build', '-c', 'rslib.test.config.ts'];

// The `--watch` build, alive for the run in watch mode only.
let watcher: ChildProcess | undefined;

/**
 * Every browser project declares this; the build runs once per Vitest run.
 * spawnSync blocks the event loop, so a second project's setup cannot start
 * before the flag is set. In watch mode a `--watch` build follows, so an edit
 * to src/ reaches tests/build/ and Vite's watcher reruns the tests.
 */
export default function setup(project: TestProject) {
  // BSQ_TEST_BUILT skips only the one-shot build: after a config-triggered
  // restart in watch mode, setup runs again and the watcher must follow.
  if (process.env.BSQ_TEST_BUILT !== '1') {
    process.env.BSQ_TEST_BUILT = '1';
    const built = spawnSync('pnpm', BUILD, { cwd: ROOT, stdio: 'inherit' });
    if (built.status !== 0) {
      throw new Error(
        `rslib.test.config.ts: the build failed (exit ${built.status})`,
      );
    }
  }
  if (!project.vitest.config.watch || watcher) return;
  const started = spawn('pnpm', [...BUILD, '--watch'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  watcher = started;
  return () => {
    if (started.pid) process.kill(-started.pid, 'SIGTERM');
    if (watcher === started) watcher = undefined;
  };
}
