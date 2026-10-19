import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockPath, runOnce } from '../../../scripts/install-lock.ts';
import { timeScale } from '../../../scripts/processes.ts';

const fixture = join(
  process.cwd(),
  'tests',
  'unit',
  'fixtures',
  'install-lock-child.ts',
);
const TIMEOUT = 30_000 * timeScale();

let stateDir: string;
let path: string;
let installsLog: string;
let children: ChildProcess[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'install-lock-'));
  path = lockPath(stateDir);
  installsLog = join(stateDir, 'installs.log');
  children = [];
});

// A failing test must not leave a hanging child behind.
afterEach(() => {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL');
});

function spawnChild(
  args: string[],
  env: Record<string, string> = {},
): ChildProcess {
  const child = spawn(process.execPath, [fixture, path, stateDir, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}

function childWithStderr(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const child = spawnChild(args, env);
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) =>
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr })),
  );
}

const child = async (
  args: string[],
  env: Record<string, string> = {},
): Promise<number> => (await childWithStderr(args, env)).code;

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000 * timeScale();
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    await new Promise((resume) => setTimeout(resume, 20));
  }
}

const lines = (file: string): string[] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('scripts/install-lock.ts', () => {
  it('lockPath is short and distinct per cache dir', () => {
    // Falsifiable: put the cache dir in the socket name and a deep checkout overflows macOS's 104 bytes.
    const a = lockPath(join(tmpdir(), 'x'.repeat(200), 'a'));
    expect(a.length).toBeLessThan(104);
    expect(lockPath('/one/cache')).not.toBe(lockPath('/two/cache'));
    expect(lockPath('/one/cache')).toBe(lockPath('/one/cache'));
  });

  it('touches no socket when already done', async () => {
    // Falsifiable: listen before checking done() and this rejects (the directory does not exist).
    await expect(
      runOnce({
        path: join(tmpdir(), 'no-such-dir', 's.sock'),
        done: async () => true,
        install: async () => {
          throw new Error('never');
        },
        installBound: 1000,
        waitBound: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it(
    'installs once for five processes on a cold state',
    async () => {
      // Falsifiable: let every process install and installs.log has five lines.
      const codes = await Promise.all(
        Array.from({ length: 5 }, () => child(['ok'])),
      );
      expect(codes).toEqual([0, 0, 0, 0, 0]);
      expect(lines(installsLog)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "hands the leader's error to every waiter",
    async () => {
      // Falsifiable: close the socket on error without a line and the waiters re-elect and install again.
      const results = await Promise.all(
        Array.from({ length: 3 }, () => childWithStderr(['throw'])),
      );
      for (const r of results) {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('fixture install failed');
      }
      expect(lines(installsLog)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'takes over from a leader killed mid-install',
    async () => {
      // Falsifiable: treat a close without a line as "ready" and the waiters exit with no install done.
      const leader = spawnChild(['hang']);
      await waitForFile(join(stateDir, 'started'));
      const waiters = [child(['ok']), child(['ok'])];
      leader.kill('SIGKILL');
      expect(await Promise.all(waiters)).toEqual([0, 0]);
      expect(existsSync(join(stateDir, 'a'))).toBe(true);
      expect(lines(installsLog)).toHaveLength(2); // the killed one, then exactly one take-over
    },
    TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'recovers a stale socket file (no stale file exists on Windows named pipes)',
    async () => {
      // Falsifiable: treat ECONNREFUSED as an error and this child exits 1.
      const leader = spawnChild(['hang']);
      await waitForFile(join(stateDir, 'started'));
      leader.kill('SIGKILL');
      await once(leader, 'exit');
      expect(existsSync(path)).toBe(true);
      expect(await child(['ok'])).toBe(0);
    },
    TIMEOUT,
  );

  it(
    're-elects when ready does not cover this request',
    async () => {
      // Falsifiable: return on "ready" without checking done() and item b is never installed.
      const [x, y] = await Promise.all([
        child(['ok', 'a']),
        child(['ok', 'b']),
      ]);
      expect([x, y]).toEqual([0, 0]);
      expect(
        existsSync(join(stateDir, 'a')) && existsSync(join(stateDir, 'b')),
      ).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'fails a leader whose install outlives its bound, and its waiters with it',
    async () => {
      // Falsifiable: no bound on install() and both children hang until the test times out.
      const env = { INSTALL_BOUND_MS: '500', WAIT_BOUND_MS: '5000' };
      const r = await Promise.all([
        childWithStderr(['hang'], env),
        childWithStderr(['hang'], env),
      ]);
      for (const x of r) {
        expect(x.code).toBe(1);
        expect(x.stderr).toMatch(/did not finish within/);
      }
    },
    TIMEOUT,
  );

  it(
    'fails a waiter after its own bound when the leader hangs without its bound firing',
    async () => {
      // Falsifiable: no waitBound and the waiter hangs.
      const leader = spawnChild(['hang'], { INSTALL_BOUND_MS: '60000' });
      await waitForFile(join(stateDir, 'started'));
      const w = await childWithStderr(['ok'], { WAIT_BOUND_MS: '500' });
      leader.kill('SIGKILL');
      expect(w.code).toBe(1);
      expect(w.stderr).toMatch(
        /waited .* for the install led by another process/,
      );
    },
    TIMEOUT,
  );
});
