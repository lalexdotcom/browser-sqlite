import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  driverLostLine,
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

  it('retries once when the browser driver never accepted a connection', async () => {
    // macOS 27 runner, run 43613237206: the isolated Safari probe's
    // safaridriver never came up, in two cells of one matrix.
    const driverDown = new Error(
      'PLAN_PROBE: probe isolated safari reported no features (no test)\n  Unable to connect to "http://localhost:49348/", make sure browser driver is running on that address.\nIt seems like the service failed to start or is rejecting any connections.',
    );
    const lines: string[] = [];
    const result = await retryUnconnectedSession(
      () => Promise.reject(driverDown),
      () => Promise.resolve(['f']),
      (line) => lines.push(line),
    );
    expect(result).toEqual(['f']);
    expect(lines).toEqual([
      'test-plan: retrying in a Vitest of its own — Unable to connect to "http://localhost:49348/", make sure browser driver is running on that address.',
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

describe('driverLostLine', () => {
  // What Vitest raises when a cell's browser session drops mid-run (macOS 26,
  // run 40344020443): the cause carries VITEST_BROWSER_CONNECTION_CLOSED.
  const closed = new Error(
    'Failed to run the test /repo/tests/browser/pairs/tx-quiesce.test.ts.',
    {
      cause: Object.assign(new Error('the browser connection was closed'), {
        code: 'VITEST_BROWSER_CONNECTION_CLOSED',
      }),
    },
  );

  it('names a session that dropped mid-run', () => {
    expect(driverLostLine([closed], 0)).toBe(
      'browser connection closed: Failed to run the test /repo/tests/browser/pairs/tx-quiesce.test.ts.',
    );
  });

  it('names a session the driver never opened', () => {
    const unconnected = new Error(
      'Unable to connect to "http://localhost:49348/", make sure browser driver is running on that address.\nIt seems like the service failed to start or is rejecting any connections.',
    );
    expect(driverLostLine([new Error('other'), unconnected], 0)).toBe(
      'Unable to connect to "http://localhost:49348/", make sure browser driver is running on that address.',
    );
  });

  it('reads an error that is a plain object, as a serialised one is', () => {
    expect(
      driverLostLine(
        [
          {
            message:
              'Failed to connect to the browser session "e5b2" within the timeout.',
          },
        ],
        0,
      ),
    ).toBe(
      'Failed to connect to the browser session "e5b2" within the timeout.',
    );
  });

  // Falsifiable: ignore the failed count, and a test that failed for a reason
  // of its own before the session dropped gets a second chance.
  it('says nothing when a test failed of its own', () => {
    expect(driverLostLine([closed], 1)).toBeUndefined();
  });

  it('says nothing of any other error', () => {
    expect(
      driverLostLine([new Error('AssertionError: expected 1 to be 2')], 0),
    ).toBeUndefined();
    expect(driverLostLine([], 0)).toBeUndefined();
  });
});
