import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CacheItem,
  FIREFOX_POLICIES,
  firefoxPoliciesPath,
  installItem,
  isInstalled,
  MARKER,
  renameWithRetry,
  STAGING,
  sweepStaging,
} from '../../../scripts/browser-cache.ts';

let cache: string;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'bsq-cache-'));
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

type FakeItem = CacheItem & { fetches: number };

/** An item that writes `bin/tool` (content `x`) under its target, after an optional delay. */
function fake(
  opts: { delay?: number; fail?: boolean; policies?: boolean } = {},
): FakeItem {
  const item: FakeItem = {
    dir: 'tool/v1',
    executable: join('bin', 'tool'),
    policies: opts.policies ?? false,
    fetches: 0,
    fetch: async (target) => {
      item.fetches += 1;
      if (opts.delay !== undefined) await sleep(opts.delay);
      mkdirSync(join(target, 'bin'), { recursive: true });
      writeFileSync(join(target, 'bin', 'tool'), 'x');
      if (opts.fail) throw new Error('download broke');
    },
  };
  return item;
}

describe('installItem', () => {
  it('publishes the installation with its marker and returns the executable', async () => {
    // Falsifiable: fetch straight into the final folder and a fetch that throws leaves it behind (next test).
    const exe = await installItem(cache, fake());
    expect(exe).toBe(join(cache, 'tool/v1', 'bin', 'tool'));
    expect(isInstalled(cache, fake())).toBe(true);
    expect(readdirSync(join(cache, STAGING))).toEqual([]);
  });

  it('leaves nothing at the final path when the fetch fails', async () => {
    // Falsifiable: fetch straight into the final folder and the half-written tree stays there.
    await expect(installItem(cache, fake({ fail: true }))).rejects.toThrow(
      'download broke',
    );
    expect(existsSync(join(cache, 'tool/v1'))).toBe(false);
    expect(readdirSync(join(cache, STAGING))).toEqual([]);
  });

  it('does not fetch an installation already marked', async () => {
    // Falsifiable: skip the isInstalled check and the counter reads 2.
    const item = fake();
    await installItem(cache, item);
    await installItem(cache, item);
    expect(item.fetches).toBe(1);
  });

  it('replaces an installation found without its marker', async () => {
    mkdirSync(join(cache, 'tool/v1/bin'), { recursive: true });
    writeFileSync(join(cache, 'tool/v1/bin/tool'), 'half');
    // Falsifiable: accept an existing executable as installed (what @puppeteer/browsers does) and this reads 'half'.
    await installItem(cache, fake());
    expect(readFileSync(join(cache, 'tool/v1/bin/tool'), 'utf8')).toBe('x');
  });

  it('lets two installers race on one item without damage', async () => {
    // Falsifiable: rethrow the loser's rename error and one of the two rejects.
    const [a, b] = await Promise.all([
      installItem(cache, fake({ delay: 50 })),
      installItem(cache, fake({ delay: 80 })),
    ]);
    expect(a).toBe(b);
    expect(isInstalled(cache, fake())).toBe(true);
    expect(readdirSync(join(cache, STAGING))).toEqual([]);
  });

  it('publishes the Firefox policy with the installation', async () => {
    // Falsifiable: write the policy after the rename and it is missing from what was published.
    await installItem(cache, fake({ policies: true }));
    const path = firefoxPoliciesPath(join(cache, 'tool/v1', 'bin', 'tool'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FIREFOX_POLICIES);
    expect(readFileSync(path, 'utf8')).toBe(
      `${JSON.stringify(FIREFOX_POLICIES, null, 2)}\n`,
    );
  });

  it('retries a rename refused for a moment', async () => {
    // Falsifiable: no retry and it rejects with "cannot publish".
    let refused = 0;
    const flaky = ((from, to) => {
      if (refused < 2) {
        refused += 1;
        throw Object.assign(new Error('operation not permitted'), {
          code: 'EPERM',
        });
      }
      renameSync(from, to);
    }) as typeof renameSync;
    const exe = await installItem(cache, fake(), flaky);
    expect(refused).toBe(2);
    expect(exe).toBe(join(cache, 'tool/v1', 'bin', 'tool'));
    expect(isInstalled(cache, fake())).toBe(true);
    expect(readdirSync(join(cache, STAGING))).toEqual([]);
  });

  it('reports a rename refused for another reason without retrying', async () => {
    // Falsifiable: swallow the error and the call resolves with nothing published.
    let calls = 0;
    const broken = (() => {
      calls += 1;
      throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    }) as typeof renameSync;
    await expect(installItem(cache, fake(), broken)).rejects.toThrow(
      /browsers: cannot publish .*tool.v1.*: disk gone/,
    );
    expect(calls).toBe(1);
    expect(existsSync(join(cache, 'tool/v1'))).toBe(false);
    expect(readdirSync(join(cache, STAGING))).toEqual([]);
  });
});

describe('installItem when removing the staging folder fails', () => {
  const stuck = (): void => {
    throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  };

  it('still resolves to the published executable for a lost race', async () => {
    // Falsifiable: let the removal error escape and the loser rejects although the installation is whole.
    const lose = ((_from: string, to: string) => {
      mkdirSync(join(to, 'bin'), { recursive: true });
      writeFileSync(join(to, 'bin', 'tool'), 'x');
      writeFileSync(join(to, MARKER), '');
      throw Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' });
    }) as typeof renameSync;
    const exe = await installItem(cache, fake(), lose, stuck);
    expect(exe).toBe(join(cache, 'tool/v1', 'bin', 'tool'));
  });

  it('rethrows the fetch error, not the removal error', async () => {
    // Falsifiable: let the removal error escape and "resource busy" replaces "download broke".
    await expect(
      installItem(cache, fake({ fail: true }), renameSync, stuck),
    ).rejects.toThrow('download broke');
  });

  it('reports the rename cause, not the removal error', async () => {
    // Falsifiable: let the removal error escape and the rename cause is hidden.
    const broken = (() => {
      throw Object.assign(new Error('disk gone'), { code: 'EIO' });
    }) as typeof renameSync;
    await expect(installItem(cache, fake(), broken, stuck)).rejects.toThrow(
      'disk gone',
    );
  });
});

describe('sweepStaging', () => {
  it('sweeps the staging folder of a killed installer', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(child, 'exit');
    const dead = join(cache, STAGING, `${child.pid}-abc`);
    mkdirSync(join(dead, 'bin'), { recursive: true });
    // Falsifiable: leave it and a later publish could pick up a half-written tree.
    sweepStaging(cache);
    expect(existsSync(dead)).toBe(false);
  });

  it('keeps the staging folder of a live installer', () => {
    // Falsifiable: sweep everything and a second leader breaks the first one's download.
    const live = join(cache, STAGING, `${process.pid}-abc`);
    mkdirSync(join(live, 'bin'), { recursive: true });
    sweepStaging(cache);
    expect(existsSync(live)).toBe(true);
  });

  it('keeps going and does not throw when one dead entry cannot be removed', () => {
    // Falsifiable: let the removal error escape the loop and the entries after the stuck one stay, or the call throws.
    // Names without a pid prefix count as dead.
    for (const name of ['a-stuck', 'b-free', 'c-free'])
      mkdirSync(join(cache, STAGING, name), { recursive: true });
    const removed: string[] = [];
    const remove = (path: string): void => {
      if (path.endsWith('a-stuck')) {
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      removed.push(path);
      rmSync(path, { recursive: true, force: true });
    };
    expect(() => sweepStaging(cache, remove)).not.toThrow();
    expect(readdirSync(join(cache, STAGING)).sort()).toEqual(['a-stuck']);
    expect(removed).toHaveLength(2);
  });

  it('removes an entry whose name carries no pid, and tolerates a missing .staging', () => {
    // Falsifiable: keep unparsable names and strays pile up for ever.
    sweepStaging(cache);
    mkdirSync(join(cache, STAGING, 'stray'), { recursive: true });
    sweepStaging(cache);
    expect(existsSync(join(cache, STAGING, 'stray'))).toBe(false);
  });
});

describe('renameWithRetry', () => {
  it('retries a rename refused for a moment, then moves the folder', async () => {
    // Falsifiable: no retry and the first EBUSY rejects.
    const from = join(cache, 'from');
    const to = join(cache, 'to');
    mkdirSync(from);
    let refused = 0;
    const flaky = ((a, b) => {
      if (refused < 2) {
        refused += 1;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      renameSync(a, b);
    }) as typeof renameSync;
    await renameWithRetry(from, to, flaky);
    expect(refused).toBe(2);
    expect(existsSync(to)).toBe(true);
    expect(existsSync(from)).toBe(false);
  });

  it('rethrows another error at once', async () => {
    // Falsifiable: retry every error and the rename is called more than once.
    let calls = 0;
    const missing = (() => {
      calls += 1;
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    }) as typeof renameSync;
    await expect(
      renameWithRetry(join(cache, 'a'), join(cache, 'b'), missing),
    ).rejects.toThrow('no such file');
    expect(calls).toBe(1);
  });
});
