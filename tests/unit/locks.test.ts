import { describe, expect, it } from '@rstest/core';
import {
  createLocks,
  noOpLocks,
  stagingLockName,
  staleStagingTables,
} from '../../src/locks';

describe('staleStagingTables', () => {
  const file = 'app.db';

  it('keeps a staging table whose lock is held', () => {
    const held = [stagingLockName(file, '__bsq_staging_a')];
    expect(staleStagingTables(['__bsq_staging_a'], held, file)).toEqual([]);
  });

  it('collects a staging table nobody holds', () => {
    expect(staleStagingTables(['__bsq_staging_a'], [], file)).toEqual([
      '__bsq_staging_a',
    ]);
  });

  it('ignores locks held for another database file', () => {
    const held = [stagingLockName('other.db', '__bsq_staging_a')];
    expect(staleStagingTables(['__bsq_staging_a'], held, file)).toEqual([
      '__bsq_staging_a',
    ]);
  });

  it('collects several at once and keeps the live one', () => {
    const held = [stagingLockName(file, '__bsq_staging_b')];
    expect(
      staleStagingTables(
        ['__bsq_staging_a', '__bsq_staging_b', '__bsq_staging_c'],
        held,
        file,
      ),
    ).toEqual(['__bsq_staging_a', '__bsq_staging_c']);
  });
});

describe('createLocks', () => {
  /** Minimal in-memory stand-in for navigator.locks. */
  const fakeManager = () => {
    const held = new Set<string>();
    return {
      held,
      request: (name: string, ...rest: any[]) => {
        const callback = rest.length === 1 ? rest[0] : rest[1];
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => {
          held.delete(name);
        });
      },
      query: async () => ({
        held: [...held].map((name) => ({ name })),
        pending: [],
      }),
    } as any;
  };

  it('holds a lock until the returned releaser is called', async () => {
    const manager = fakeManager();
    const locks = createLocks(manager);

    const release = await locks.hold('bsq:staging:app.db:t');
    expect(await locks.heldNames()).toContain('bsq:staging:app.db:t');

    release();
    // The release resolves the callback's promise; let it settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(await locks.heldNames()).not.toContain('bsq:staging:app.db:t');
  });

  it('runs a function under an exclusive lock', async () => {
    const manager = fakeManager();
    const locks = createLocks(manager);

    const seen: string[] = [];
    const result = await locks.withLock('bsq:sweep:app.db', async () => {
      seen.push(...(await locks.heldNames()));
      return 42;
    });

    expect(result).toBe(42);
    expect(seen).toContain('bsq:sweep:app.db');
  });

  it('degrades to a no-op when the API is unavailable', async () => {
    const locks = noOpLocks;

    expect(locks.available).toBe(false);
    expect(await locks.heldNames()).toEqual([]);
    const release = await locks.hold('x');
    expect(() => release()).not.toThrow();
    expect(await locks.withLock('x', async () => 'ran')).toBe('ran');
  });

  it('rejects hold() when the lock manager rejects', async () => {
    const manager = {
      request: async () => {
        throw new Error('AbortError');
      },
      query: async () => ({ held: [], pending: [] }),
    } as any;
    const locks = createLocks(manager);
    await expect(locks.hold('bsq:staging:app.db:t')).rejects.toThrow(
      'AbortError',
    );
  }, 1000);
});
