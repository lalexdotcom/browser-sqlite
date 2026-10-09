import { describe, expect, it } from '@rstest/core';
import { encodeParams } from '../../src/binary';
import { createLogger } from '../../src/logger';
import { createPoolWorker, type PoolWorker } from '../../src/pool';
import { databasePath } from '../../src/utils';
import { createTestClient, removeDatabaseFiles, TEST_TARGET } from './helpers';

const typed = 'SELECT typeof(v) AS t, quote(v) AS q FROM p ORDER BY rowid';

describe('params', () => {
  it('binds every kind of value as the conversion rules say', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE p (v)');
    const at = new Date(Date.UTC(2026, 9, 6, 12, 34, 56, 789));
    const values: unknown[] = [
      2 ** 31 - 1,
      -(2 ** 31),
      2 ** 31,
      1.5,
      2n ** 63n - 1n,
      -(2n ** 63n),
      'é€😀',
      '',
      Uint8Array.of(1, 2),
      new Uint8Array(0),
      true,
      null,
      undefined,
      { a: 1 },
      [1, 2, 300],
      at,
      '\ud800',
    ];
    for (const v of values) await db.write('INSERT INTO p VALUES (?)', [v]);
    expect(await db.read(typed)).toEqual([
      { t: 'integer', q: '2147483647' },
      { t: 'integer', q: '-2147483648' },
      { t: 'real', q: '2147483648.0' },
      { t: 'real', q: '1.5' },
      { t: 'integer', q: '9223372036854775807' },
      { t: 'integer', q: '-9223372036854775808' },
      { t: 'text', q: "'é€😀'" },
      { t: 'text', q: "''" },
      { t: 'blob', q: "X'0102'" },
      { t: 'blob', q: "X''" },
      { t: 'integer', q: '1' },
      { t: 'null', q: 'NULL' },
      { t: 'null', q: 'NULL' },
      { t: 'text', q: `'{"a":1}'` },
      { t: 'text', q: "'[1,2,300]'" },
      { t: 'text', q: "'2026-10-06 12:34:56.789'" },
      { t: 'text', q: "'�'" },
    ]);
    await db.close();
  });

  it('refuses an unbindable param before any worker sees it', async () => {
    const db = await createTestClient({ debug: true });
    await db.write('CREATE TABLE p (v)');
    const before = (db.debug?.requests ?? []).length;
    await expect(
      db.write('INSERT INTO p VALUES (?)', [Symbol('s')]),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(db.read('SELECT ?', [() => 1])).rejects.toMatchObject({
      code: 'INVALID_VALUE',
    });
    await expect(db.first('SELECT ?', [2n ** 64n])).rejects.toMatchObject({
      code: 'INVALID_VALUE',
    });
    const gen = db.stream('SELECT ?', [Symbol('s')]);
    await expect(gen.next()).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(
      db.chunk('SELECT ?', [Symbol('s')]).next(),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await db.transaction(async (tx) => {
      expect(() => tx.read('SELECT ?', [Symbol('s')])).toThrow(
        expect.objectContaining({ code: 'INVALID_VALUE' }),
      );
    });
    // No request for the refused calls reached a worker.
    const sent = (db.debug?.requests ?? [])
      .slice(before)
      .flatMap((r) => r.queries)
      .filter((q) => q.sql === 'SELECT ?');
    expect(sent).toHaveLength(0);
    await db.close();
  });

  it('binds an ArrayBuffer, a DataView and a typed array as the BLOB of their bytes', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE p (v)');
    const buf = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7).buffer;
    const values: unknown[] = [
      Float32Array.of(1, 2),
      Uint8Array.of(9, 8).buffer,
      new DataView(buf, 2, 3),
      new Int16Array(buf, 4, 2),
    ];
    for (const v of values) await db.write('INSERT INTO p VALUES (?)', [v]);
    expect(await db.read(typed)).toEqual([
      { t: 'blob', q: "X'0000803F00000040'" },
      { t: 'blob', q: "X'0908'" },
      { t: 'blob', q: "X'020304'" },
      { t: 'blob', q: "X'04050607'" },
    ]);
    expect(
      await db.read('SELECT hex(?) AS h', [new Float32Array([1])]),
    ).toEqual([{ h: '0000803F' }]);
    await db.close();
  });

  it('refuses params that are not an array', async () => {
    const db = await createTestClient();
    await expect(
      db.read('SELECT :a', { ':a': 1 } as never),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await db.close();
  });

  it('takes null params as no params, as untyped code may pass them', async () => {
    const db = await createTestClient();
    expect(await db.read('SELECT 1 AS x, ? AS y', null as never)).toEqual([
      { x: 1, y: null },
    ]);
    await db.close();
  });

  it('binds as many values as the statement has parameters, by index', async () => {
    const db = await createTestClient();
    expect(await db.read('SELECT ? AS a', [1, 2])).toEqual([{ a: 1 }]);
    expect(await db.read('SELECT ? AS a, ? AS b', [1])).toEqual([
      { a: 1, b: null },
    ]);
    expect(await db.read('SELECT ?2 AS a, ?1 AS b', [1, 2])).toEqual([
      { a: 2, b: 1 },
    ]);
    expect(await db.read('SELECT :x AS a', [7])).toEqual([{ a: 7 }]);
    await db.close();
  });

  it("binds NULL, not the previous call's value, to a cached statement re-run with fewer values", async () => {
    // Fails if `settle()` in worker.ts stops calling `clear_bindings`: the
    // second run would still carry the first run's `'y'` in the second slot.
    const db = await createTestClient({ poolSize: 1 });
    expect(await db.read('SELECT ? AS a, ? AS b', ['x', 'y'])).toEqual([
      { a: 'x', b: 'y' },
    ]);
    expect(await db.read('SELECT ? AS a, ? AS b', ['x'])).toEqual([
      { a: 'x', b: null },
    ]);
    await db.close();
  });

  describe('a multi-statement string', () => {
    const rows = 'SELECT t, v FROM m ORDER BY rowid';

    // Falsifiable: bind every statement from the first value in worker.ts.
    it('gives each statement of anonymous `?` the next values', async () => {
      const db = await createTestClient();
      await db.write('CREATE TABLE m (t, v)');
      await db.write(
        "INSERT INTO m VALUES ('a', ?), ('a', ?); DELETE FROM m WHERE t = 'z'; INSERT INTO m VALUES ('b', ?)",
        ['x', 'y', 'z'],
      );
      expect(await db.read(rows)).toEqual([
        { t: 'a', v: 'x' },
        { t: 'a', v: 'y' },
        { t: 'b', v: 'z' },
      ]);
      await db.close();
    });

    // Falsifiable: give one tag the wrong width in bindBlock's skip loop.
    it('skips every kind of value to reach the cursor', async () => {
      const db = await createTestClient();
      await db.write('CREATE TABLE m (t, v)');
      const skipped = [null, 7, 1.5, 2n ** 40n, 'é€😀', Uint8Array.of(1, 2, 3)];
      await db.write(
        `SELECT ${skipped.map(() => '?').join(', ')}; INSERT INTO m VALUES ('b', ?)`,
        [...skipped, 'z'],
      );
      expect(await db.read(rows)).toEqual([{ t: 'b', v: 'z' }]);
      await db.close();
    });

    it('binds NULL where the values run out, and ignores extra ones', async () => {
      const db = await createTestClient();
      await db.write('CREATE TABLE m (t, v)');
      await db.write(
        "INSERT INTO m VALUES ('a', ?); INSERT INTO m VALUES ('b', ?)",
        ['x'],
      );
      await db.write(
        "INSERT INTO m VALUES ('c', ?); INSERT INTO m VALUES ('d', ?)",
        ['x', 'y', 'z'],
      );
      expect(await db.read(rows)).toEqual([
        { t: 'a', v: 'x' },
        { t: 'b', v: null },
        { t: 'c', v: 'x' },
        { t: 'd', v: 'y' },
      ]);
      await db.close();
    });

    // Falsifiable: move the cursor on a statement with a numbered or named param.
    it('reads numbered and named params from the first value, without moving the cursor', async () => {
      const db = await createTestClient();
      await db.write('CREATE TABLE m (t, v)');
      await db.write(
        "INSERT INTO m VALUES ('a', ?2); INSERT INTO m VALUES ('b', ?1); INSERT INTO m VALUES ('c', :x)",
        ['x', 'y'],
      );
      await db.write(
        "INSERT INTO m VALUES ('d', ?); INSERT INTO m VALUES ('e', ?2); INSERT INTO m VALUES ('f', ?)",
        ['x', 'y', 'z'],
      );
      expect(await db.read(rows)).toEqual([
        { t: 'a', v: 'y' },
        { t: 'b', v: 'x' },
        { t: 'c', v: 'x' },
        { t: 'd', v: 'x' },
        { t: 'e', v: 'y' },
        { t: 'f', v: 'y' },
      ]);
      await db.close();
    });

    it('applies the same rule to a read, and from a cleared cursor on each call', async () => {
      const db = await createTestClient({ poolSize: 1 });
      const twice = 'SELECT ? AS a; SELECT ? AS a, ? AS b';
      expect(await db.read(twice, [1, 2, 3])).toEqual([
        { a: 1 },
        { a: 2, b: 3 },
      ]);
      expect(await db.read(twice, [4, 5, 6])).toEqual([
        { a: 4 },
        { a: 5, b: 6 },
      ]);
      await db.close();
    });
  });

  it('round-trips a param larger than the wasm heap', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE b (v)');
    const big = new Uint8Array(64 << 20);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 255;
    await db.write('INSERT INTO b VALUES (?)', [big]);
    const [row] = await db.read<{ n: number; h: string }>(
      'SELECT length(v) AS n, hex(substr(v, 1 + 4096 * 3, 1)) AS h FROM b',
    );
    // Byte 1 + 4096 * 3 (1-based) is index 3 * 4096, set to 3 above.
    expect(row).toEqual({ n: 64 << 20, h: '03' });
    await db.close();
  }, 120_000);

  it('rebinds a cached statement after an aborted query', async ({ skip }) => {
    const db = await createTestClient({
      poolSize: 1,
      needs: ['interruptible'],
      skip,
    });
    const sql =
      'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ?) SELECT max(i) AS m, ? AS tag FROM c';
    const controller = new AbortController();
    const slow = db.read(sql, [50_000_000, 'first'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(slow).rejects.toBeDefined();
    expect(await db.read(sql, [3, 'second'])).toEqual([
      { m: 3, tag: 'second' },
    ]);
    await db.close();
  }, 60_000);
});

describe('one converted params array, sent twice', () => {
  it('binds the same values on the second send', async () => {
    const file = `prm-${Date.now().toString(36)}`;
    const opened = await createPoolWorker({
      index: 0,
      pool: [] as (PoolWorker | undefined)[],
      clientName: 'params',
      file: databasePath(TEST_TARGET.vfs, file),
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      drainTimeout: 5000,
      logger: createLogger('test', false),
    });
    if ('declined' in opened)
      throw new Error(`worker declined: ${opened.declined}`);
    const worker = opened;
    try {
      const params = [1, 'two'];
      for (let i = 0; i < 2; i++) {
        const rows: unknown[] = [];
        for await (const c of worker.query('SELECT ? AS a, ? AS b', params))
          if (typeof c !== 'number') rows.push(...c);
        expect(rows).toEqual([{ a: 1, b: 'two' }]);
      }
    } finally {
      await worker.close();
      worker.terminate();
      await removeDatabaseFiles(file, TEST_TARGET.vfs);
    }
  });

  it('rejects at once when encoding throws, and leaves the worker usable', async () => {
    const file = `prm-${Date.now().toString(36)}`;
    const opened = await createPoolWorker({
      index: 0,
      pool: [] as (PoolWorker | undefined)[],
      clientName: 'params',
      file: databasePath(TEST_TARGET.vfs, file),
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      drainTimeout: 20_000,
      logger: createLogger('test', false),
    });
    if ('declined' in opened)
      throw new Error(`worker declined: ${opened.declined}`);
    const worker = opened;
    const drain = async (params?: Parameters<PoolWorker['query']>[1]) => {
      const rows: unknown[] = [];
      for await (const c of worker.query('SELECT ? AS a', params))
        if (typeof c !== 'number') rows.push(...c);
      return rows;
    };
    try {
      const encoded = encodeParams([1]);
      expect(await drain(encoded)).toEqual([{ a: 1 }]);
      const started = performance.now();
      // A second send makes `toMessage()` throw, before anything is posted.
      await expect(drain(encoded)).rejects.toThrow(/already sent/);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(await drain([2])).toEqual([{ a: 2 }]);
    } finally {
      await worker.close();
      worker.terminate();
      await removeDatabaseFiles(file, TEST_TARGET.vfs);
    }
  });
});
