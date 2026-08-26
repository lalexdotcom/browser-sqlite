import { describe, expect, it } from '@rstest/core';
import {
  createLocks,
  initLockName,
  noOpLocks,
  stagingLockName,
  staleStagingTables,
  sweepLockName,
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

describe('initLockName', () => {
  it('is distinct per database file', () => {
    expect(initLockName('a.db')).not.toBe(initLockName('b.db'));
  });

  it('does not collide with the sweep or staging namespaces', () => {
    expect(initLockName('a.db')).not.toBe(sweepLockName('a.db'));
    expect(initLockName('a.db').startsWith('bsq:init:')).toBe(true);
  });
});

describe('tryWithLock', () => {
  /**
   * A LockManager stand-in. `ifAvailable: true` makes the real API invoke the
   * callback with `null` when the lock is held elsewhere; `granted` chooses
   * which of the two the fake plays.
   */
  const manager = (granted: boolean, seen?: unknown[]) => ({
    request: async (_name: string, options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      if (typeof options !== 'function') seen?.push(options);
      return cb(granted ? {} : null);
    },
    query: async () => ({ held: [] as { name?: string }[] }),
  });

  it('does not run the callback when the lock is held elsewhere', async () => {
    let ran = false;
    const locks = createLocks(manager(false));

    const acquired = await locks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(acquired).toBe(false);
  });

  it('runs the callback when the lock is free', async () => {
    let ran = false;
    const locks = createLocks(manager(true));

    const acquired = await locks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(acquired).toBe(true);
  });

  // Falsifiable: drop `ifAvailable` from the request options. Without it the
  // real API waits, which is the whole thing this method exists not to do —
  // and no behavioural assertion above can see the difference against a fake.
  it('asks for ifAvailable, which is what makes it never wait', async () => {
    const seen: unknown[] = [];
    const locks = createLocks(manager(true, seen));

    await locks.tryWithLock('n', async () => {});

    expect(seen[0]).toEqual({ mode: 'exclusive', ifAvailable: true });
  });

  it('runs the callback when the Web Locks API is absent', async () => {
    let ran = false;

    const acquired = await noOpLocks.tryWithLock('n', async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(acquired).toBe(true);
  });
});
