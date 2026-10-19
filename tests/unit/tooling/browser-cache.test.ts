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
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CacheItem,
  FIREFOX_POLICIES,
  firefoxPoliciesPath,
  installItem,
  isInstalled,
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

  it('writes the Firefox policy before the marker', async () => {
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

describe('sweepStaging', () => {
  it('sweeps a staging folder left by a killed installer', () => {
    mkdirSync(join(cache, STAGING, 'dead', 'bin'), { recursive: true });
    sweepStaging(cache);
    // Falsifiable: leave the folder and a later publish could pick up a half-written tree.
    expect(existsSync(join(cache, STAGING))).toBe(false);
    expect(existsSync(dirname(join(cache, STAGING)))).toBe(true);
  });
});
