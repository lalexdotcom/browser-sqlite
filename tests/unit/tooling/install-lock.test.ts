import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, Socket } from 'node:net';
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

// A failing test must not leave a hanging child, a state dir or a socket file behind.
afterEach(() => {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(stateDir, { recursive: true, force: true });
  if (process.platform !== 'win32') rmSync(path, { force: true });
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

const waitingCount = (): number =>
  readdirSync(stateDir).filter((name) => name.startsWith('waiting-')).length;

async function waitForWaiters(count: number): Promise<void> {
  const deadline = Date.now() + 10_000 * timeScale();
  while (waitingCount() < count) {
    if (Date.now() > deadline) throw new Error(`${count} waiters never showed`);
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

  it('lockPath gives C:\\ and c:\\ one lock on Windows only', () => {
    // Falsifiable: hash the path as given and the two spellings of one Windows directory get two locks.
    expect(lockPath('C:\\Cache\\wdio', 'win32')).toBe(
      lockPath('c:\\cache\\WDIO', 'win32'),
    );
    expect(lockPath('/One/cache', 'linux')).not.toBe(
      lockPath('/one/cache', 'linux'),
    );
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
        // Any of the three may lead; the leader holds until the other two wait.
        Array.from({ length: 3 }, () =>
          childWithStderr(['throw'], { AWAIT_WAITERS: '2' }),
        ),
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
      // Falsifiable: treat a close without a line as an error and the waiters exit 1.
      // Falsifiable: return on a close without a line and the waiters exit 0 with item a never installed.
      const leader = spawnChild(['hang']);
      await waitForFile(join(stateDir, 'started'));
      const waiting = [child(['ok']), child(['ok'])];
      await waitForWaiters(2);
      leader.kill('SIGKILL');
      expect(await Promise.all(waiting)).toEqual([0, 0]);
      expect(existsSync(join(stateDir, 'a'))).toBe(true);
      // The killed leader, then one take-over; on POSIX two waiters can both unlink
      // the stale file in turn and both lead (accepted gap, no guard around the unlink).
      const count = lines(installsLog).length;
      if (process.platform === 'win32') expect(count).toBe(2);
      else expect([2, 3]).toContain(count);
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
        child(['ok', 'a'], { AWAIT_WAITERS: '1' }),
        child(['ok', 'b'], { AWAIT_WAITERS: '1' }),
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

  // A leader is refused between its bind() and its listen(); a seam that refuses
  // a number of connects stands in for that window.
  const refusing = (times: number, then: (path: string) => Socket) => {
    let left = times;
    return (target: string): Socket => {
      if (left-- <= 0) return then(target);
      const socket = new Socket();
      process.nextTick(() =>
        socket.emit(
          'error',
          Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        ),
      );
      return socket;
    };
  };

  it.skipIf(process.platform === 'win32')(
    'keeps the socket of a leader that refuses only for a moment',
    async () => {
      // Falsifiable: unlink at the first ECONNREFUSED and the live socket is removed, this process installs.
      const server = createServer((socket) => socket.end('ready\n'));
      await new Promise<void>((listening) => server.listen(path, listening));
      let ready = false;
      let installed = false;
      try {
        await runOnce({
          path,
          done: async () => {
            const was = ready;
            ready = true; // the leader's answer is what makes it done
            return was;
          },
          install: async () => {
            installed = true;
          },
          installBound: 1000,
          waitBound: 5000,
          connect: refusing(2, (target) => createConnection(target)),
        });
        expect(installed).toBe(false);
        expect(existsSync(path)).toBe(true);
      } finally {
        server.close();
      }
    },
    TIMEOUT,
  );

  it.skipIf(process.platform === 'win32')(
    'takes a socket that refuses throughout as stale and leads',
    async () => {
      // Falsifiable: never unlink after a refusal and this process loops until the test times out.
      writeFileSync(path, ''); // a socket file nobody listens on
      let installed = false;
      await runOnce({
        path,
        done: async () => installed,
        install: async () => {
          installed = true;
        },
        installBound: 1000,
        waitBound: 5000,
        connect: refusing(Number.POSITIVE_INFINITY, createConnection),
      });
      expect(installed).toBe(true);
    },
    TIMEOUT,
  );
});
