import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUSY_RETRY_BUDGET_MS,
  createVfsInstance,
} from '../../../src/worker/create-vfs';

const INSTANCE = { name: 'the VFS' };

/**
 * A VFS class whose `create()` fails with each of `failures` in turn, each
 * after `delayMs`, then succeeds. `null` in place of the list fails forever.
 */
const fakeVfs = (failures: DOMException[] | null, delayMs = 0) => {
  let attempts = 0;
  const vfsClass: VFSClass = {
    create: () => {
      const failure =
        failures === null
          ? new DOMException('', 'UnknownError')
          : failures[attempts];
      attempts += 1;
      return new Promise((resolve, reject) =>
        setTimeout(
          () => (failure ? reject(failure) : resolve(INSTANCE)),
          delayMs,
        ),
      );
    },
  };
  return { vfsClass, attempts: () => attempts };
};

const create = (vfsClass: VFSClass, onWait = () => {}) =>
  createVfsInstance(vfsClass, 'IDBMirrorVFS', {} as WASQLiteModule, onWait);

describe('createVfsInstance — an IndexedDB open Firefox gave up on', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Firefox answers `UnknownError` only after its own 10 s busy loop, so the
  // first failure lands past any deadline taken before the first attempt.
  // Falsifiable: count the busy budget from before the first attempt.
  it('retries an UnknownError that arrives after 10 s, and returns the VFS', async () => {
    const { vfsClass, attempts } = fakeVfs(
      [new DOMException('', 'UnknownError')],
      10_000,
    );
    const created = create(vfsClass);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(created).resolves.toBe(INSTANCE);
    expect(attempts()).toBe(2);
  });

  it('rethrows the UnknownError once its own budget is spent', async () => {
    const { vfsClass, attempts } = fakeVfs(null);
    const created = create(vfsClass);
    const settled = vi.fn();
    created.then(settled, settled);

    await vi.advanceTimersByTimeAsync(BUSY_RETRY_BUDGET_MS - 1_000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(created).rejects.toMatchObject({ name: 'UnknownError' });
    expect(attempts()).toBeGreaterThan(1);
  });

  it('rethrows any other error at once', async () => {
    const { vfsClass, attempts } = fakeVfs([
      new DOMException('', 'QuotaExceededError'),
    ]);
    const created = create(vfsClass);
    created.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);

    await expect(created).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(attempts()).toBe(1);
  });

  // Matched on the name: an Error whose message says it is still engine prose.
  it('does not read the message', async () => {
    const { vfsClass, attempts } = fakeVfs([
      new Error('UnknownError') as DOMException,
    ]);
    const created = create(vfsClass);
    created.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);

    await expect(created).rejects.toThrow('UnknownError');
    expect(attempts()).toBe(1);
  });

  it('still waits out a held file, and says so once', async () => {
    const held = new DOMException('', 'NoModificationAllowedError');
    const { vfsClass, attempts } = fakeVfs([held, held, held]);
    const onWait = vi.fn();
    const created = create(vfsClass, onWait);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(created).resolves.toBe(INSTANCE);
    expect(attempts()).toBe(4);
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});
