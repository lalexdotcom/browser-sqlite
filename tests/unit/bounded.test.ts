import { spawn } from 'node:child_process';
import { describe, expect, it } from '@rstest/core';

/**
 * `scripts/bounded.mjs` is what keeps a hung run from sitting for ever — in a
 * pre-push hook or a CI job, that is the difference between a failed run and a
 * lost runner. It is exercised here rather than trusted: a bound nobody proves
 * is a bound nobody has.
 */

const run = (args: string[]): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn('node', ['scripts/bounded.mjs', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
  });

describe('scripts/bounded.mjs', () => {
  it('passes a finished command its own exit code', async () => {
    // Falsifiable: map the child's code to 0 and this goes red.
    expect(await run(['10', 'node', '-e', 'process.exit(0)'])).toMatchObject({
      code: 0,
    });
    expect(await run(['10', 'node', '-e', 'process.exit(3)'])).toMatchObject({
      code: 3,
    });
  });

  it('kills a command that passes its deadline and exits 124', async () => {
    // Falsifiable: remove the setTimeout that kills the child and this test
    // hangs instead of passing — which is exactly the failure it guards.
    const { code, stderr } = await run([
      '1',
      'node',
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    expect(code).toBe(124);
    expect(stderr).toContain('without finishing');
  }, 20_000);

  // `pnpm exec rstest` is such a command: the deadline killed the pnpm launcher
  // and left rstest and its browser running under init (2026-10-01).
  // Falsifiable: signal the child alone (`child.kill`) and the grandchild
  // outlives the run.
  it('kills what the command started too, not only the command', async () => {
    const { code, stderr } = await run([
      '1',
      'node',
      '-e',
      [
        "const { spawn } = require('node:child_process');",
        "const g = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "console.error('GRANDCHILD ' + g.pid);",
        'setInterval(() => {}, 1000);',
      ].join(' '),
    ]);
    const pid = Number(/GRANDCHILD (\d+)/.exec(stderr)?.[1]);
    expect(code).toBe(124);
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
    }
  }, 20_000);

  it('reports a command that does not exist rather than hanging', async () => {
    const { code, stderr } = await run(['10', 'definitely-not-a-command-here']);
    expect(code).toBe(127);
    expect(stderr).toContain('could not run');
  });

  it('refuses a call it cannot honour', async () => {
    expect((await run(['0', 'node', '-e', ''])).code).toBe(2);
    expect((await run(['not-a-number', 'node'])).code).toBe(2);
    expect((await run(['10'])).code).toBe(2);
  });
});
