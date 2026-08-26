import { describe, expect, it } from '@rstest/core';
import { sweepLockName } from '../../src/locks';
import { createTestClient } from './helpers';

describe('bulkWrite inside a transaction', () => {
  it('writes nothing when the transaction rolls back', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (a INTEGER)');

    await expect(
      db.transaction(async (tx) => {
        const bulk = tx.bulkWrite('t', ['a']);
        bulk.enqueue({ a: 1 });
        bulk.enqueue({ a: 2 });
        await bulk.close();
        const inside = await tx.read<{ n: number }>(
          'SELECT count(*) AS n FROM t',
        );
        expect(inside[0].n).toBe(2);
        throw new Error('caller gave up');
      }),
    ).rejects.toThrow('caller gave up');

    const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
    expect(rows[0].n).toBe(0);
  });

  it('writes every row when the transaction commits', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (a INTEGER)');

    await db.transaction(async (tx) => {
      const bulk = tx.bulkWrite('t', ['a']);
      bulk.enqueue({ a: 1 });
      bulk.enqueue({ a: 2 });
      await bulk.close();
    });

    const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
    expect(rows[0].n).toBe(2);
  });
});

describe('output inside a transaction', () => {
  it('leaves the previous target and no staging table when it rolls back', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE target (a INTEGER)');
    await db.write('INSERT INTO target VALUES (42)');

    await expect(
      db.transaction(async (tx) => {
        const out = tx.output('target', { a: 'INTEGER' });
        out.enqueue({ a: 7 });
        await out.close();
        throw new Error('caller gave up');
      }),
    ).rejects.toThrow('caller gave up');

    const rows = await db.read<{ a: number }>('SELECT a FROM target');
    expect(rows).toEqual([{ a: 42 }]);

    const staging = await db.read<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE '__bsq_staging_%'`,
    );
    expect(staging).toEqual([]);
  });

  it('replaces the target when it commits', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE target (a INTEGER)');
    await db.write('INSERT INTO target VALUES (42)');

    await db.transaction(async (tx) => {
      const out = tx.output('target', { a: 'INTEGER' });
      out.enqueue({ a: 7 });
      await out.close();
    });

    const rows = await db.read<{ a: number }>('SELECT a FROM target');
    expect(rows).toEqual([{ a: 7 }]);
  });
});

describe('a read-only transaction', () => {
  // Falsifiable: build the stub lazily, so the throw moves to close(). The
  // `expect(() => …).toThrow` form is what pins the timing — a caller must not
  // be handed a writer that fails only after it has enqueued a million rows.
  it('refuses bulkWrite at the call, not at the first flush', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE t (a INTEGER)');

    await db.transaction(
      async (tx) => {
        expect(() => tx.bulkWrite('t', ['a'])).toThrow(
          expect.objectContaining({ code: 'READ_ONLY_TRANSACTION' }),
        );
      },
      { readOnly: true },
    );
  });

  it('refuses output at the call', async () => {
    const db = await createTestClient();

    await db.transaction(
      async (tx) => {
        expect(() => tx.output('t', { a: 'INTEGER' })).toThrow(
          expect.objectContaining({ code: 'READ_ONLY_TRANSACTION' }),
        );
      },
      { readOnly: true },
    );
  });

  it('rejects a write statement with a SQLiteError, not a bare Error', async () => {
    const db = await createTestClient();

    await expect(
      db.transaction(
        async (tx) => {
          await tx.write('CREATE TABLE nope (a INTEGER)');
        },
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ code: 'READ_ONLY_TRANSACTION' });
  });
});

describe('the staging sweep under a transaction', () => {
  // Falsifiable: change tryWithLock back to withLock in bulk.ts's sweepOnce.
  // The transaction then waits on a lock this test never releases and the race
  // below rejects.
  it('does not stall while another holder has the sweep lock', async () => {
    // debug: true is how the test learns the NORMALIZED database name --
    // ClientDebugState.file is set from client.ts's `dbFile`, so the lock name
    // is exact rather than assumed. createTestClient does not return the name
    // it generates, and changing that would touch fifteen browser test files.
    const db = await createTestClient({ debug: true });
    const lockName = sweepLockName(db.debug!.file);

    await db.write('CREATE TABLE target (a INTEGER)');
    // A staging table nobody holds a lock for: the sweep would drop it.
    await db.write('CREATE TABLE __bsq_staging_orphan (a INTEGER)');

    let releaseSweepLock!: () => void;
    const lockTaken = new Promise<void>((taken) => {
      navigator.locks.request(lockName, () => {
        taken();
        return new Promise<void>((release) => {
          releaseSweepLock = release;
        });
      });
    });
    await lockTaken;

    try {
      const finished = db.transaction(async (tx) => {
        // Mandatory: takes SQLite's write lock, which BEGIN alone does not.
        await tx.write('INSERT INTO target VALUES (1)');
        const out = tx.output('target', { a: 'INTEGER' });
        out.enqueue({ a: 2 });
        await out.close();
      });

      await Promise.race([
        finished,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'the transaction stalled: the sweep waited for a lock it should have skipped',
                ),
              ),
            5000,
          ),
        ),
      ]);

      // The control. If this orphan is gone the sweep ran, which means the lock
      // name did not match and the test proved nothing about skipping.
      const staging = await db.read<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name = '__bsq_staging_orphan'`,
      );
      expect(staging).toHaveLength(1);
    } finally {
      releaseSweepLock();
    }
  });
});
