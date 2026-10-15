import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  killTree,
  packageBin,
  parseTimeScale,
  timeScale,
} from '../../../scripts/processes.ts';

describe('packageBin', () => {
  it('starts a package CLI with this Node, on the file its manifest names', () => {
    const [node, script] = packageBin('vitest', 'vitest');
    expect(node).toBe(process.execPath);
    expect(script).toMatch(/[\\/]vitest[\\/]vitest\.mjs$/);
    expect(existsSync(script)).toBe(true);
    expect(packageBin('@rslib/core', 'rslib')[1]).toMatch(/rslib\.js$/);
  });

  it('refuses a bin the package does not declare', () => {
    expect(() => packageBin('vitest', 'nope')).toThrow(
      /vitest declares no bin "nope"/,
    );
  });

  // Falsifiable: route the call through a shell — the argument splits at its spaces.
  it('hands an argument with spaces and a middle dot over intact', async () => {
    const name = 'chrome · OPFSAdaptiveVFS/jspi';
    const child = spawn(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        name,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    await new Promise((resolve) => child.on('close', resolve));
    expect(JSON.parse(out)).toEqual([name]);
  });
});

describe('killTree', () => {
  // Falsifiable: drop /T — taskkill then leaves the browser and its driver alive.
  it('kills the whole tree with taskkill on Windows', () => {
    const calls: [string, string[]][] = [];
    killTree(1234, 'SIGKILL', {
      platform: 'win32',
      run: (command, args) => calls.push([command, args]),
    });
    expect(calls).toEqual([['taskkill', ['/T', '/F', '/PID', '1234']]]);
  });

  it.skipIf(process.platform === 'win32')(
    'signals the process group elsewhere',
    async () => {
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'ignore' },
      );
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.on('exit', (_code, signal) => resolve(signal)),
      );
      killTree(child.pid as number, 'SIGKILL', { platform: 'linux' });
      expect(await exited).toBe('SIGKILL');
    },
  );

  it('ignores a group that is already gone', () => {
    expect(() =>
      killTree(2 ** 22 - 1, 'SIGKILL', { platform: 'linux' }),
    ).not.toThrow();
  });
});

describe('parseTimeScale', () => {
  it('is 1 when BSQ_TIME_SCALE is unset or empty', () => {
    expect(parseTimeScale(undefined)).toBe(1);
    expect(parseTimeScale('')).toBe(1);
  });

  it('takes a positive number, fractions included', () => {
    expect(parseTimeScale('4')).toBe(4);
    expect(parseTimeScale('1.5')).toBe(1.5);
  });

  // Falsifiable: fall back to 1 on a bad value — a typo then silently keeps
  // Linux's bounds on a platform that needs four times them.
  it('refuses anything else, naming the variable', () => {
    for (const bad of ['0', '-2', 'four', 'Infinity']) {
      expect(() => parseTimeScale(bad)).toThrow(/BSQ_TIME_SCALE/);
    }
  });
});

describe('timeScale', () => {
  // Falsifiable: read anything but BSQ_TIME_SCALE — the Windows workflow's
  // factor then never reaches the bounds.
  it('reads BSQ_TIME_SCALE', () => {
    const saved = process.env.BSQ_TIME_SCALE;
    try {
      process.env.BSQ_TIME_SCALE = '2.5';
      expect(timeScale()).toBe(2.5);
      delete process.env.BSQ_TIME_SCALE;
      expect(timeScale()).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.BSQ_TIME_SCALE;
      else process.env.BSQ_TIME_SCALE = saved;
    }
  });
});
