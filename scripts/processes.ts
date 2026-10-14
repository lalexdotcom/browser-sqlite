/**
 * Starting and stopping child processes the same way on Linux, macOS and
 * Windows: what `scripts/parallel.ts`, `scripts/bounded.ts` and the test
 * harness share.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * POSIX: the child leads its own process group, so `killTree` reaches what it
 * started. Windows has no process groups; there a detached child only gets a
 * console of its own.
 */
export const DETACHED = process.platform !== 'win32';

/**
 * `BSQ_TIME_SCALE`: how many times slower than Linux a platform runs the
 * suite, applied to every bound of a run (per test, per job, whole command)
 * so they keep their ratios. 1 when unset. Firefox on Windows needs it: every
 * OPFS file open, close or delete costs it 50-220 ms of fsyncs (Mozilla bug
 * 2072928).
 */
export function timeScale(
  raw: string | undefined = process.env.BSQ_TIME_SCALE,
): number {
  if (raw === undefined || raw === '') return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`BSQ_TIME_SCALE="${raw}" is not a positive number`);
  }
  return scale;
}

/**
 * `[node, <the package's bin script>]`: a package's CLI started with this Node.
 * `pnpm exec <cli>` goes through `pnpm.cmd` on Windows, which Node spawns only
 * with a shell, and a shell splits the project names Vitest is given
 * (`chrome · OPFSAdaptiveVFS/jspi`) at their spaces.
 */
export function packageBin(
  pkg: string,
  bin: string,
  root: string = ROOT,
): [node: string, script: string] {
  const dir = join(root, 'node_modules', pkg);
  const manifest = JSON.parse(
    readFileSync(join(dir, 'package.json'), 'utf8'),
  ) as { bin?: string | Record<string, string> };
  const relative =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (relative === undefined) {
    throw new Error(`${pkg} declares no bin "${bin}"`);
  }
  return [process.execPath, join(dir, relative)];
}

/**
 * Kills `pid` and everything it started. POSIX: signals the process group
 * (the child must have been spawned with `detached: DETACHED`). Windows:
 * `taskkill /T /F`, the tree by parentage — Windows has no signals, so
 * `signal` is ignored there and every kill is forced. A tree already gone is
 * fine.
 */
export function killTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
  {
    platform = process.platform,
    run = (command, args) => {
      spawnSync(command, args, { stdio: 'ignore' });
    },
  }: {
    platform?: NodeJS.Platform;
    run?: (command: string, args: string[]) => void;
  } = {},
): void {
  if (platform === 'win32') {
    run('taskkill', ['/T', '/F', '/PID', String(pid)]);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}
