import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

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

    // chunk() is an async generator: the throw arrives on the first next(),
    // not at the call.
    const call = async () => {
      for await (const _ of db.chunk('DELETE FROM t')) break;
    };

    await expect(call()).rejects.toMatchObject({ code: 'NOT_A_READ_QUERY' });
    const rows = await db.read('SELECT * FROM t');
    expect(rows.length).toBe(1);
  });

  // Falsifiable: delete the assertReadable call in stream() in src/client.ts
  // and this case silently runs the DELETE.
  it('stream() rejects a write statement', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await db.write('INSERT INTO t (a) VALUES (1)');

    // stream() is an async generator: the throw arrives on the first next(),
    // not at the call.
    const call = async () => {
      for await (const _ of db.stream('DELETE FROM t')) break;
    };

    await expect(call()).rejects.toMatchObject({ code: 'NOT_A_READ_QUERY' });
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

  // Falsifiable: put the ternary back on write()'s acquire in src/client.ts.
  it('write() accepts a read statement and routes it to the writer', async () => {
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
    await db.close();
  });
});
