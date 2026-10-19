/**
 * Staged installations of the browser cache: each one is built in a private
 * folder under `.staging/`, marked complete, then published by a single rename,
 * so a path in the cache either holds a whole installation or does not exist.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { timeScale } from './processes.ts';

/**
 * Firefox updates itself in place when launched outside WebDriver (geckodriver's
 * profiles disable it; a hand launch for a measurement does not): this policy stops it for every profile.
 */
export const FIREFOX_POLICIES = { policies: { DisableAppUpdate: true } };

/** Where Firefox reads its policies: `distribution/` beside the binary, under `Contents/Resources/` in a macOS bundle. */
export const firefoxPoliciesPath = (executable: string): string => {
  const dir = dirname(executable);
  return basename(dir) === 'MacOS'
    ? join(dir, '..', 'Resources', 'distribution', 'policies.json')
    : join(dir, 'distribution', 'policies.json');
};

/** One browser or driver installation in the cache. */
export interface CacheItem {
  /** Folder of the installation, relative to the cache (`chrome/linux_arm-153.0.8010.52`). */
  dir: string;
  /** The executable, relative to `dir`. */
  executable: string;
  /** Whether Firefox's policy file belongs next to the executable. */
  policies: boolean;
  /** Fills the absolute folder `target` with the installation (the layout under `dir`). */
  fetch: (target: string) => Promise<void>;
}

/** Written last in an installation: its presence means the folder is whole. */
export const MARKER = '.bsq-complete';

/** Private build folders of the installers, inside the cache so a rename stays on one volume. */
export const STAGING = '.staging';

/** Rename errors Windows raises while an antivirus or indexer holds a fresh file. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_EVERY_MS = 100;
const RETRY_FOR_MS = 2_000;

const reason = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const code = (err: unknown): unknown => (err as NodeJS.ErrnoException)?.code;

export function isInstalled(cacheDir: string, item: CacheItem): boolean {
  return existsSync(join(cacheDir, item.dir, MARKER));
}

/** Whether a process with this pid exists; EPERM means it does, under another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return code(err) === 'EPERM';
  }
}

/** Removes the staging folders of dead installers; the elected installer calls it before it starts. */
export function sweepStaging(cacheDir: string): void {
  const root = join(cacheDir, STAGING);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    // Only dead owners: after a crash two leaders may run, and a live one's copy is still being filled.
    const pid = /^(\d+)-/.exec(entry)?.[1];
    if (pid !== undefined && isAlive(Number(pid))) continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

/**
 * Builds `item` in a staging folder and publishes it by rename; returns the
 * absolute executable. An installation found without its marker is replaced.
 * `rename` is a test seam.
 */
export async function installItem(
  cacheDir: string,
  item: CacheItem,
  rename: typeof renameSync = renameSync,
  remove: (path: string) => void = (path) =>
    rmSync(path, { recursive: true, force: true }),
): Promise<string> {
  const final = join(cacheDir, item.dir);
  const executable = join(final, item.executable);
  if (isInstalled(cacheDir, item)) return executable;

  if (existsSync(final)) {
    try {
      rmSync(final, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `browsers: cannot remove the incomplete installation ${final}: ${reason(err)}`,
      );
    }
  }

  const staging = join(cacheDir, STAGING, `${process.pid}-${randomUUID()}`);
  // Best effort: a leftover (Windows holding a file) is swept later and must not mask the real outcome.
  const discard = (): void => {
    try {
      remove(staging);
    } catch {}
  };
  try {
    mkdirSync(staging, { recursive: true });
    await item.fetch(staging);
    if (item.policies) {
      const policies = firefoxPoliciesPath(join(staging, item.executable));
      mkdirSync(dirname(policies), { recursive: true });
      writeFileSync(policies, `${JSON.stringify(FIREFOX_POLICIES, null, 2)}\n`);
    }
    writeFileSync(join(staging, MARKER), '');
    mkdirSync(dirname(final), { recursive: true });
  } catch (err) {
    discard();
    throw err;
  }

  const deadline = Date.now() + RETRY_FOR_MS * timeScale();
  for (;;) {
    try {
      rename(staging, final);
      return executable;
    } catch (err) {
      if (isInstalled(cacheDir, item)) {
        // Another installer published first: its tree is as good as ours.
        discard();
        return executable;
      }
      if (TRANSIENT.has(code(err) as string) && Date.now() < deadline) {
        await sleep(RETRY_EVERY_MS);
        continue;
      }
      discard();
      throw new Error(`browsers: cannot publish ${final}: ${reason(err)}`);
    }
  }
}
