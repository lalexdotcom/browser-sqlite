/**
 * A process that wants an item installed through `runOnce`, for
 * tests/unit/tooling/install-lock.test.ts.
 *
 *   node install-lock-child.ts <lockPath> <stateDir> <ok|throw|hang> [<item>]
 *
 * Env AWAIT_WAITERS (default 0): `install()` first waits until that many
 * processes have written a `waiting-<pid>` marker, i.e. are connected to a leader.
 */
import {
  appendFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runOnce } from '../../../scripts/install-lock.ts';

const [path, stateDir, mode, item = 'a'] = process.argv.slice(2);
if (path === undefined || stateDir === undefined || mode === undefined) {
  throw new Error(
    'usage: install-lock-child <lockPath> <stateDir> <mode> [item]',
  );
}

// A trace on stderr, for the test's report when it fails: when, who, what.
const trace = (what: string) =>
  process.stderr.write(`${Date.now()} ${process.pid} ${what}\n`);
trace(`start ${mode} ${item}`);

const sleep = (ms: number) => new Promise((resume) => setTimeout(resume, ms));
const awaited = Number(process.env.AWAIT_WAITERS ?? 0);
const waiting = () =>
  readdirSync(stateDir).filter((name) => name.startsWith('waiting-')).length;

try {
  await runOnce({
    path,
    done: async () => existsSync(join(stateDir, item)),
    install: async () => {
      trace('install');
      appendFileSync(
        join(stateDir, 'installs.log'),
        `${process.pid} ${item}\n`,
      );
      writeFileSync(join(stateDir, 'started'), '');
      if (mode === 'hang') return new Promise<void>(() => {});
      while (waiting() < awaited) await sleep(20);
      if (mode === 'throw') throw new Error('fixture install failed');
      await sleep(300);
      writeFileSync(join(stateDir, item), '');
    },
    log: (line) => {
      trace(line);
      if (line.startsWith('waiting'))
        writeFileSync(join(stateDir, `waiting-${process.pid}`), '');
    },
    installBound: Number(process.env.INSTALL_BOUND_MS ?? 5000),
    waitBound: Number(process.env.WAIT_BOUND_MS ?? 8000),
  });
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
