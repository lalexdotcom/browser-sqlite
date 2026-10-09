import { describe, expect, it } from '@rstest/core';
import { type SQLiteQueryAPI, type SQLQuery, sql } from '../../src/index';
import { createTestClient } from './helpers';

/** Every query method with a query built by `sql`, options in second position. */
const exercise = async (db: SQLiteQueryAPI) => {
  await db.write(sql`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
  const inserted = await db.write(
    sql`INSERT INTO t (id, v) VALUES (${1}, ${'a'}), (${2}, ${'b'})`,
  );
  expect(inserted.affected).toBe(2);
  expect(await db.read(sql`SELECT v FROM t WHERE id = ${2}`)).toEqual([
    { v: 'b' },
  ]);
  expect(await db.first(sql`SELECT v FROM t WHERE id = ${1}`)).toEqual({
    v: 'a',
  });
  const chunks: unknown[] = [];
  // chunkSize 1 proves the options are read from the second argument.
  for await (const c of db.chunk(
    sql`SELECT id FROM t WHERE id >= ${1} ORDER BY id`,
    { chunkSize: 1 },
  ))
    chunks.push(c);
  expect(chunks).toEqual([[{ id: 1 }], [{ id: 2 }]]);
  const rows: unknown[] = [];
  for await (const r of db.stream(sql`SELECT id FROM t WHERE id > ${1}`))
    rows.push(r);
  expect(rows).toEqual([{ id: 2 }]);
};

/** Untyped code passing params anyway: rejected, never read as options. */
const misuse = (db: SQLiteQueryAPI) =>
  Promise.resolve().then(() => db.read(sql`SELECT ${1} AS one`, [1] as never));

describe('sql tag', () => {
  it('runs on every query method of the client', async () => {
    const db = await createTestClient();
    await exercise(db);
    await db.close();
  });

  it('runs on every query method of a transaction', async () => {
    const db = await createTestClient();
    await db.transaction((tx) => exercise(tx));
    expect(await db.read(sql`SELECT count(*) AS n FROM t`)).toEqual([{ n: 2 }]);
    await db.close();
  });

  it('refuses a query followed by a params array, on the client and in a transaction', async () => {
    const db = await createTestClient();
    await expect(misuse(db)).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await db.transaction(async (tx) => {
      await expect(misuse(tx)).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    });
    await db.close();
  });

  it('stores sql.jsonb objects as JSONB and plain sql objects as JSON text', async () => {
    const db = await createTestClient();
    await db.write(sql`CREATE TABLE j (doc)`);
    const doc = { a: [1, 'x'], b: null };
    await db.write(sql.jsonb`INSERT INTO j VALUES (${doc})`);
    await db.write(sql`INSERT INTO j VALUES (${doc})`);
    expect(
      await db.read(
        sql`SELECT typeof(doc) AS t, json(doc) AS j FROM j ORDER BY rowid`,
      ),
    ).toEqual([
      { t: 'blob', j: '{"a":[1,"x"],"b":null}' },
      { t: 'text', j: '{"a":[1,"x"],"b":null}' },
    ]);
    // A string keeps ?: it compares as text, not as JSONB.
    expect(await db.first(sql.jsonb`SELECT ${'x'} = 'x' AS same`)).toEqual({
      same: 1,
    });
    await db.close();
  });

  it('matches sql.list against integers, strings, dates and a bigint past 2^53', async () => {
    const db = await createTestClient();
    await db.write(sql`CREATE TABLE n (id INTEGER, s TEXT, at TEXT)`);
    await db.write(
      sql`INSERT INTO n VALUES (${1}, ${'a'}, strftime('%Y-%m-%d %H:%M:%f', '2026-10-08 12:00:00')), (${2}, ${'b'}, NULL), (${3}, ${'c'}, NULL), (${2n ** 53n}, ${'big'}, NULL)`,
    );
    const names = async (where: SQLQuery) =>
      (
        await db.read<{ s: string }>(
          sql`SELECT s FROM n WHERE ${where} ORDER BY s`,
        )
      ).map((r) => r.s);
    expect(await names(sql`id IN ${sql.list([1, 3])}`)).toEqual(['a', 'c']);
    expect(await names(sql`s IN ${sql.list(['b', 'c', 'z'])}`)).toEqual([
      'b',
      'c',
    ]);
    expect(
      await names(sql`at IN ${sql.list([new Date(Date.UTC(2026, 9, 8, 12))])}`),
    ).toEqual(['a']);
    // Exact: 2^53 + 1 written as a double would round to 2^53 and match.
    expect(await names(sql`id IN ${sql.list([2n ** 53n + 1n])}`)).toEqual([]);
    expect(await names(sql`id IN ${sql.list([2n ** 53n])}`)).toEqual(['big']);
    expect(await names(sql`id IN ${sql.list([])}`)).toEqual([]);
    await db.close();
  });

  it('binds each statement of a multi-statement string to its own values', async () => {
    const db = await createTestClient();
    await db.write(sql`CREATE TABLE a (v); CREATE TABLE b (v)`);
    await db.write(
      sql`INSERT INTO a VALUES (${'x'}); INSERT INTO b VALUES (${'y'})`,
    );
    expect(
      await db.read(sql`SELECT (SELECT v FROM a) AS a, (SELECT v FROM b) AS b`),
    ).toEqual([{ a: 'x', b: 'y' }]);
    await db.close();
  });
});
