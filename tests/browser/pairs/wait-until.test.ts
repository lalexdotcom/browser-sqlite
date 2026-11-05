import { describe, expect, it } from 'vitest';
import { waitUntil } from '../helpers';

/**
 * `waitUntil` waits for a state with no bound of its own: the test's timeout
 * is the bound. A fixed 5 s used to fail tests on starved CI runners while the
 * state was only late (GitHub's macOS 26 runner, `lifecycle`, 2026-11-04).
 * The helper's own behaviour, so one VFS is enough.
 */
describe('waitUntil', { tags: ['vfs:MemoryVFS'] }, () => {
  // Falsifiable: give the wait its old 5 s default bound — it throws "timed
  // out after 5000 ms" before the state comes.
  it('waits for a state that comes after its old 5 s bound', {
    timeout: 20_000,
  }, async () => {
    const at = Date.now() + 6_000;
    await waitUntil(() => Date.now() >= at, 'a late state');
    expect(Date.now()).toBeGreaterThanOrEqual(at);
  });

  // Falsifiable: stop checking the signal — the wait polls on after the test
  // ended and never rejects.
  it('stops when its test ends, naming what it waited for', async () => {
    const ended = new AbortController();
    let checks = 0;
    const wait = waitUntil(
      () => {
        checks += 1;
        return false;
      },
      'a state that never comes',
      undefined,
      ended.signal,
    );
    setTimeout(() => ended.abort(), 100);
    await expect(wait).rejects.toThrow(
      'the test ended while waiting for a state that never comes',
    );
    const after = checks;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(checks).toBe(after);
  });

  it('still honours a bound given to it', async () => {
    await expect(waitUntil(() => false, 'nothing', 100)).rejects.toThrow(
      /^timed out after \d+ ms waiting for nothing$/,
    );
  });
});
