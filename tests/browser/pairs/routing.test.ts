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

  // Falsifiable: delete the assertReadable call in chunk() in src/client.ts
  // and this case silently runs the DELETE.
  it('chunk() rejects a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    // The throw is at the call, not on the first next().
    expect(() => db.chunk('DELETE FROM t')).toThrow(
      expect.objectContaining({ code: 'NOT_A_READ_QUERY' }),
    );
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(1);
  });

  // Falsifiable: delete the assertReadable call in stream() in src/client.ts
  // and this case silently runs the DELETE.
  it('stream() rejects a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    // The throw is at the call, not on the first next().
    expect(() => db.stream('DELETE FROM t')).toThrow(
      expect.objectContaining({ code: 'NOT_A_READ_QUERY' }),
    );
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(1);
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

  // Falsifiable: drop the method passed to checksql() by tx's read methods in
  // src/transaction.ts and the DELETEs run.
  it("a transaction's read(), first(), chunk() and stream() reject a write statement", async () => {
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
      expect(() => tx.chunk('DELETE FROM t')).toThrow(
        expect.objectContaining({ code: 'NOT_A_READ_QUERY' }),
      );
      expect(() => tx.stream('DELETE FROM t')).toThrow(
        expect.objectContaining({ code: 'NOT_A_READ_QUERY' }),
      );
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

  it('chunk() throws at the call for a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.chunk('CREATE TABLE t (a)')).toThrow(SQLiteError);
    expect(() => db.chunk('CREATE TABLE t (a)')).toThrow(
      expect.objectContaining({ code: 'NOT_A_READ_QUERY' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('stream() throws at the call for a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    expect(() => db.stream('CREATE TABLE t (a)')).toThrow(SQLiteError);
    expect(() => db.stream('CREATE TABLE t (a)')).toThrow(
      expect.objectContaining({ code: 'NOT_A_READ_QUERY' }),
    );
    expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
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
