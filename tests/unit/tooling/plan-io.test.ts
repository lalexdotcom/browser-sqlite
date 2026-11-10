import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  namedTestFiles,
  retryUnconnectedSession,
} from '../../../scripts/plan-io.ts';

describe('namedTestFiles', () => {
  it('finds a file argument among the files Vitest globbed', () => {
    const globbed = ['/repo/tests/a.test.ts', '/repo/tests/b.test.ts'];
    expect(
      namedTestFiles(globbed, ['tests/b.test.ts'], posix, '/repo'),
    ).toEqual(['/repo/tests/b.test.ts']);
  });

  it('keeps nothing for an argument that names no test file', () => {
    const globbed = ['/repo/tests/a.test.ts'];
    expect(
      namedTestFiles(globbed, ['tests/typo.test.ts'], posix, '/repo'),
    ).toEqual([]);
  });

  // Falsifiable: compare `resolve(root, file)` with the globbed path, as
  // before — on Windows it has `\` and Vitest's paths `/`, so nothing matches
  // (seen on windows-latest, 2026-10-30).
  it("finds it on Windows, where Vitest globs with '/' and resolve() gives '\\'", () => {
    const globbed = ['C:/repo/tests/a.test.ts', 'C:/repo/tests/b.test.ts'];
    expect(
      namedTestFiles(globbed, ['tests/b.test.ts'], win32, 'C:\\repo'),
    ).toEqual(['C:/repo/tests/b.test.ts']);
    expect(
      namedTestFiles(globbed, ['tests\\a.test.ts'], win32, 'C:\\repo'),
    ).toEqual(['C:/repo/tests/a.test.ts']);
  });
});

describe('retryUnconnectedSession', () => {
  // The page of a Windows probe never reached Vitest (2026-11-06); a retry in
  // the same Vitest hangs, so the retry is handed in (a fresh Vitest).
  const unconnected = new Error(
    'PLAN_PROBE: probe isolated chrome reported no features (no test)\n  Failed to connect to the browser session "e5b2" [probe isolated chrome] within the timeout.',
  );

  it('retries once when the page never connected, and says so', async () => {
    const lines: string[] = [];
    const result = await retryUnconnectedSession(
      () => Promise.reject(unconnected),
      () => Promise.resolve(['f']),
      (line) => lines.push(line),
    );
    expect(result).toEqual(['f']);
    expect(lines).toEqual([
      'test-plan: retrying in a Vitest of its own — Failed to connect to the browser session "e5b2" [probe isolated chrome] within the timeout.',
    ]);
  });

  it('does not retry any other failure', async () => {
    // Falsifiable: retry every error and a probe that ran and found nothing is hidden.
    let retried = false;
    const other = new Error(
      'PLAN_PROBE: probe chrome reported no features (failed)',
    );
    await expect(
      retryUnconnectedSession(
        () => Promise.reject(other),
        () => {
          retried = true;
          return Promise.resolve(['f']);
        },
        () => {},
      ),
    ).rejects.toBe(other);
    expect(retried).toBe(false);
  });

  it('lets the retry fail with its own error', async () => {
    const second = new Error('second');
    await expect(
      retryUnconnectedSession(
        () => Promise.reject(unconnected),
        () => Promise.reject(second),
        () => {},
      ),
    ).rejects.toBe(second);
  });

  it('does not retry a probe that succeeded', async () => {
    let retried = false;
    expect(
      await retryUnconnectedSession(
        () => Promise.resolve(['a']),
        () => {
          retried = true;
          return Promise.resolve(['b']);
        },
        () => {},
      ),
    ).toEqual(['a']);
    expect(retried).toBe(false);
  });
});
