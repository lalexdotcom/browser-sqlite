/**
 * A process that wants an item installed through `runOnce`, for
 * tests/unit/tooling/install-lock.test.ts.
 *
 *   node install-lock-child.ts <lockPath> <stateDir> <ok|throw|hang> [<item>]
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnce } from '../../../scripts/install-lock.ts';

const [path, stateDir, mode, item = 'a'] = process.argv.slice(2);
if (path === undefined || stateDir === undefined || mode === undefined) {
  throw new Error(
    'usage: install-lock-child <lockPath> <stateDir> <mode> [item]',
  );
}

try {
  await runOnce({
    path,
    done: async () => existsSync(join(stateDir, item)),
    install: async () => {
      appendFileSync(
        join(stateDir, 'installs.log'),
        `${process.pid} ${item}\n`,
      );
      writeFileSync(join(stateDir, 'started'), '');
      if (mode === 'hang') return new Promise<void>(() => {});
      // Failing at once would let a slow-starting process find the lock free and
      // lead again; the delay keeps the other processes waiting on this leader.
      await new Promise((resume) => setTimeout(resume, 300));
      if (mode === 'throw') throw new Error('fixture install failed');
      writeFileSync(join(stateDir, item), '');
    },
    installBound: Number(process.env.INSTALL_BOUND_MS ?? 5000),
    waitBound: Number(process.env.WAIT_BOUND_MS ?? 8000),
  });
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
