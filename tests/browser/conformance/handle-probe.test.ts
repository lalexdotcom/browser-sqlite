import { describe, expect, inject, it } from 'vitest';
import { probeOnce } from '../helpers/environment';

const TIME_SCALE = inject('bsqTimeScale') ?? 1;

/** A worker that blocks its own thread for `ms` before anything else runs. */
const busy = (ms: number) =>
  `{ const end = Date.now() + ${ms}; while (Date.now() < end) {} }`;

/** Firefox's hang, on demand: `getDirectory()` that never settles. */
const HANG = 'navigator.storage.getDirectory = () => new Promise(() => {});';

describe('the OPFS handle probe', () => {
  // Falsifiable: start the answer bound when the worker is created instead of
  // on its 'up' message — the worker below is still starting when it expires,
  // and the attempt comes back 'wedged'.
  it('waits for a worker slow to start, and takes its answer', async () => {
    const answerBoundMs = 2_000 * TIME_SCALE;
    const answer = await probeOnce(1, {
      prelude: busy(answerBoundMs + 500),
      answerBoundMs,
    });
    expect(answer).toEqual({
      sync: expect.any(Boolean),
      unsafe: expect.any(Boolean),
    });
  });

  it('still writes off a started worker whose getDirectory() never settles', async () => {
    expect(await probeOnce(1, { prelude: HANG, answerBoundMs: 200 })).toBe(
      'wedged',
    );
  });

  it('says so when the worker never starts', async () => {
    expect(
      await probeOnce(1, { prelude: busy(5_000), startupBoundMs: 300 }),
    ).toBe('unstarted');
  });
});
