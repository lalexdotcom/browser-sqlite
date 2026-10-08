import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

// Every case of the spec's § 4, written by SQL so no param conversion is involved.
const CASES: [sql: string, expected: unknown][] = [
  ['0', 0],
  ['-1', -1],
  ['2147483647', 2147483647],
  ['-2147483648', -2147483648],
  ['2147483648', 2147483648],
  ['-2147483649', -2147483649],
  ['9007199254740991', 9007199254740991],
  ['-9007199254740991', -9007199254740991],
  ['9007199254740992', 9007199254740992n],
  ['-9007199254740992', -9007199254740992],
  ['-9007199254740993', -9007199254740993n],
  ['9223372036854775807', 9223372036854775807n],
  ['-9223372036854775807 - 1', -9223372036854775808n],
  ['1.5', 1.5],
  ['1e308', 1e308],
  ["''", ''],
  ["'é€😀'", 'é€😀'],
  ["CAST(x'ff' AS TEXT)", '�'],
  ["'a' || char(0) || 'b'", 'a\0b'],
  ["char(65279) || 'x'", '﻿x'],
  ["x''", new Uint8Array(0)],
  ["x'00ff'", Uint8Array.of(0, 255)],
  ['NULL', null],
];

const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  await db.write('CREATE TABLE r (id INTEGER PRIMARY KEY, v)');
  for (const [sql] of CASES)
    await db.write(`INSERT INTO r (v) VALUES (${sql})`);
};
const expected = CASES.map(([, v], i) => ({ id: i + 1, v }));

describe('result rows', () => {
  it('come back as today through every read path', async () => {
    const db = await createTestClient();
    await seed(db);
    const sql = 'SELECT id, v FROM r ORDER BY id';
    expect(await db.read(sql)).toEqual(expected);
    expect(await db.first(sql)).toEqual(expected[0]);
    const streamed: unknown[] = [];
    for await (const row of db.stream(sql, [], { chunkSize: 5 }))
      streamed.push(row);
    expect(streamed).toEqual(expected);
    const chunked: unknown[] = [];
    for await (const rows of db.chunk(sql, [], { chunkSize: 7 }))
      chunked.push(...rows);
    expect(chunked).toEqual(expected);
    expect(await db.transaction((tx) => tx.read(sql))).toEqual(expected);
    await db.close();
  });

  it('keeps a negative zero and the SQL types', async () => {
    const db = await createTestClient();
    const [row] = await db.read('SELECT -0.0 AS z, typeof(-0.0) AS t');
    expect(row).toEqual({ z: -0, t: 'real' });
    expect(Object.is(row?.z, -0)).toBe(true);
    await db.close();
  });

  it('gives each blob a buffer of its own', async () => {
    const db = await createTestClient();
    const rows = await db.read<{ b: Uint8Array }>(
      "SELECT x'010203' AS b UNION ALL SELECT zeroblob(102400)",
    );
    expect(rows[0]?.b).toEqual(Uint8Array.of(1, 2, 3));
    expect(rows[0]?.b.buffer.byteLength).toBe(3);
    expect(rows[1]?.b.length).toBe(102400);
    expect(rows[1]?.b.buffer.byteLength).toBe(102400);
    await db.close();
  });

  it('carries values larger than a chunk buffer, after small rows', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT)');
    await db.write(
      "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 50) INSERT INTO k SELECT i, 'x' || i FROM s",
    );
    await db.write("INSERT INTO k VALUES (51, printf('%.300000c', 'é'))");
    const rows = await db.read<{ id: number; v: string }>(
      'SELECT * FROM k ORDER BY id',
    );
    expect(rows).toHaveLength(51);
    expect(rows[49]).toEqual({ id: 50, v: 'x50' });
    expect(rows[50]?.v).toBe('é'.repeat(300000));
    await db.close();
  });

  it('keeps duplicated column names as today', async () => {
    const db = await createTestClient();
    expect(await db.read('SELECT 1 AS a, 2 AS a')).toEqual([{ a: 2 }]);
    await db.close();
  });

  it('gives each statement of a multi-statement string its own columns', async () => {
    const db = await createTestClient();
    const rows: unknown[] = [];
    for await (const chunk of db.chunk(
      'SELECT 1 AS a; SELECT 2 AS b, 3 AS c',
      [],
      { chunkSize: 10 },
    ))
      rows.push(chunk);
    expect(rows).toEqual([[{ a: 1 }], [{ b: 2, c: 3 }]]);
    await db.close();
  });
});
