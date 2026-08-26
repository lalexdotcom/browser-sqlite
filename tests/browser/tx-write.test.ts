import { describe, expect, it } from '@rstest/core';
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
