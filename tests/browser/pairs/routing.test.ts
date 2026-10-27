import { SQLiteError, sql } from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import { createTestClient } from '../helpers';

describe('routing — strictness', () => {
  // Falsifiable: delete the assertReadable call in read() in src/client.ts
  // and this case silently runs the DELETE.
  it('read() rejects a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    await expect(db.read('DELETE FROM t')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(1);
  });

  // Spec 2026-10-26: chunk() and stream() take any single statement.
  // Falsifiable: put the assertReadable call back in chunk() in src/client.ts.
  it('chunk() takes a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    for await (const _ of db.chunk('DELETE FROM t')) {
      // A DELETE without RETURNING delivers no chunk.
    }
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(0);
  });

  // Falsifiable: put the assertReadable call back in stream() in src/client.ts.
  it('stream() takes a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    for await (const _ of db.stream('DELETE FROM t')) {
      // A DELETE without RETURNING delivers no row.
    }
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(0);
  });

  // Falsifiable: delete the assertReadable call in first() in src/client.ts
  // and this case silently runs the DELETE.
  it('first() rejects a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    await expect(db.first('DELETE FROM t')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(1);
  });

  // Falsifiable: drop the method passed to checksql() by tx.read() in
  // src/transaction.ts and the DELETE runs.
  it("a transaction's read() and first() reject a write statement", async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    await db.transaction(async (tx) => {
      await expect(tx.read('DELETE FROM t')).rejects.toMatchObject({
        code: 'NOT_A_READ_QUERY',
      });
      await expect(tx.first('DELETE FROM t')).rejects.toMatchObject({
        code: 'NOT_A_READ_QUERY',
      });
    });
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(1);
  });

  // Falsifiable: put the ternary back on write()'s acquire in src/client.ts.
  it('write() accepts a read statement and routes it to the writer', {
    tags: ['requires:two-workers'],
  }, async () => {
    // "Routed to the WRITER" only means something where a reader exists too,
    // so the pair has to keep two workers.
    const db = await createTestClient({ poolSize: 2 });
    const { result } = await db.write<{ n: number }>('SELECT 1 AS n');
    expect(result[0]?.n).toBe(1);
  });

  // Falsifiable: remove READ_PRAGMA from isReadQuery in src/utils.ts and both
  // of these cases break.
  it('accepts a bare read pragma through read()', async () => {
    const db = await createTestClient();
    const rows = await db.read<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(rows[0]?.journal_mode).toBeDefined();
    await db.close();
  });

  it('still rejects a pragma that assigns', async () => {
    const db = await createTestClient();
    await expect(db.read('PRAGMA journal_mode=WAL')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    await expect(db.read('PRAGMA user_version(5)')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    await db.close();
  });

  // Falsifiable: drop table_info from INTROSPECTION_PRAGMAS in src/utils.ts.
  it('accepts an introspection pragma with its argument, in a read-only transaction too', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE "we""ird" (a INTEGER, b TEXT)');

    const columns = await db.read<{ name: string }>(
      'PRAGMA table_info("we""ird")',
    );
    expect(columns.map((c) => c.name)).toEqual(['a', 'b']);

    const inTx = await db.transaction(
      (tx) => tx.read<{ name: string }>('PRAGMA main.table_xinfo("we""ird")'),
      { readOnly: true },
    );
    expect(inTx.map((c) => c.name)).toEqual(['a', 'b']);
    await db.close();
  });
});

describe('chunk() and stream() — arguments are validated at the call', () => {
  // Falsifiable: move queryArgs, assertReadable or prepareParams back inside
  // the generator in src/client.ts and the call returns instead of throwing.
  // The read() on a one-worker pool shows the refused call left the pool usable.

  it('chunk() throws at the call for a first argument that is not a query', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.chunk(42 as never)).toThrow(SQLiteError);
    expect(() => db.chunk(42 as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('stream() throws at the call for a first argument that is not a query', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.stream(42 as never)).toThrow(SQLiteError);
    expect(() => db.stream(42 as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('chunk() throws at the call for a query built by sql followed by a params array', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.chunk(sql`SELECT ${1} AS one`, [1] as never)).toThrow(
      SQLiteError,
    );
    expect(() => db.chunk(sql`SELECT ${1} AS one`, [1] as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('stream() throws at the call for a query built by sql followed by a params array', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.stream(sql`SELECT ${1} AS one`, [1] as never)).toThrow(
      SQLiteError,
    );
    expect(() => db.stream(sql`SELECT ${1} AS one`, [1] as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('chunk() runs a CREATE TABLE, with affected 0', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const created = db.chunk('CREATE TABLE t (a)');
    for await (const _ of created) {
      // No rows.
    }
    expect(await created.affected).toBe(0);
    expect(await db.read('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });

  it('stream() runs a CREATE TABLE, with affected 0', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const created = db.stream('CREATE TABLE t (a)');
    for await (const _ of created) {
      // No rows.
    }
    expect(await created.affected).toBe(0);
    expect(await db.read('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });

  it('chunk() throws at the call for an unbindable param', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.chunk('SELECT ?', [Symbol('s')])).toThrow(SQLiteError);
    expect(() => db.chunk('SELECT ?', [Symbol('s')])).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('stream() throws at the call for an unbindable param', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.stream('SELECT ?', [Symbol('s')])).toThrow(SQLiteError);
    expect(() => db.stream('SELECT ?', [Symbol('s')])).toThrow(
      expect.objectContaining({ code: 'INVALID_VALUE' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });
});

describe('first() and a read-only transaction refuse writes in the worker', () => {
  const seeded = async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a INTEGER PRIMARY KEY, b)');
    await db.write('INSERT INTO t VALUES (1, 1)');
    const count = async () =>
      (await db.read<{ n: number }>('SELECT count(*) AS n FROM t'))[0]?.n;
    return { db, count };
  };

  // Falsifiable: drop the pragma clause of classifyStatement in src/classify.ts.
  it('first() rejects PRAGMA optimize', async () => {
    const { db } = await seeded();
    await expect(db.first('PRAGMA optimize')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
  });

  // Falsifiable: make the worker's kindOf answer 'write' for every statement.
  it("first() accepts a SELECT whose text holds 'INSERT'", async () => {
    const { db } = await seeded();
    expect(await db.first("SELECT 'INSERT'")).toEqual({ "'INSERT'": 'INSERT' });
  });

  it('first() accepts an EXPLAIN of a write and runs nothing', async () => {
    const { db, count } = await seeded();
    const row = await db.first('EXPLAIN INSERT INTO t VALUES (9, 9)');
    expect(row).toBeDefined();
    expect(await count()).toBe(1);
  });

  it('first() accepts a bare lookup pragma', async () => {
    const { db } = await seeded();
    expect(await db.first('PRAGMA journal_mode')).toHaveProperty(
      'journal_mode',
    );
  });

  it('first() accepts an introspection pragma with its argument', async () => {
    const { db } = await seeded();
    expect(await db.first('PRAGMA table_info(t)')).toMatchObject({ name: 'a' });
  });

  it('first() rejects a pragma that assigns', async () => {
    const { db } = await seeded();
    await expect(db.first('PRAGMA cache_size = 5')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
  });

  // Falsifiable: drop the `(` from the pattern in kindOf in src/worker/worker.ts.
  it("first() rejects a pragma that assigns '', which the authorizer reports as no value", async () => {
    const { db } = await seeded();
    await expect(db.first("PRAGMA user_version('')")).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
  });

  // Falsifiable: move the refusal after the first step in src/worker/worker.ts.
  it('first() refuses an INSERT … RETURNING before it steps, and again on a cache hit', async () => {
    const { db, count } = await seeded();
    for (const attempt of [1, 2]) {
      await expect(
        db.first('INSERT INTO t VALUES (2, 2) RETURNING a'),
      ).rejects.toMatchObject({
        code: 'NOT_A_READ_QUERY',
        message: 'first() only accepts reads; this statement writes.',
      });
      expect(await count(), `attempt ${attempt}`).toBe(1);
    }
  });

  // Falsifiable: stop sending refuseWrite from a read-only transaction's via()
  // in src/transaction.ts.
  it('a read-only transaction refuses a write, and runs a read whose text holds DELETE', async () => {
    const { db, count } = await seeded();
    await expect(
      db.transaction((tx) => tx.write('INSERT INTO t VALUES (3, 3)'), {
        readOnly: true,
      }),
    ).rejects.toMatchObject({
      code: 'READ_ONLY_TRANSACTION',
      message: 'Cannot write in a read-only transaction.',
    });
    expect(await count()).toBe(1);
    // read() still takes the page-side check until the routing lands, so the
    // reads that the text would condemn go through first() and write().
    expect(
      await db.transaction((tx) => tx.first("SELECT 'DELETE' AS word"), {
        readOnly: true,
      }),
    ).toEqual({ word: 'DELETE' });
    expect(
      await db.transaction(
        (tx) => tx.write("SELECT 'DELETE' AS word").then((r) => r.result),
        { readOnly: true },
      ),
    ).toEqual([{ word: 'DELETE' }]);
  });
});
