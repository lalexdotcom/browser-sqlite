import { describe, expect, it } from '@rstest/core';
import { SQLITE_CODES } from '../../src/const/sqlite';
import type { ClientDebugState } from '../../src/debug';
import { createTestClient, interceptWorkers } from './helpers';

/**
 * docs/superpowers/specs/2026-10-04-tx-savepoint-design.md § 4: SQLite's
 * authorizer refuses transaction control the library did not send.
 */

const REFUSED = `STATEMENT_FAILED:${SQLITE_CODES.AUTH}`;

/** 'ran', or the error's code and SQLite result code. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'ran',
    (e: { code?: string; sqliteCode?: number }) =>
      `${e.code}:${e.sqliteCode ?? ''}`,
  );

const CONTROL = [
  'BEGIN',
  'BEGIN IMMEDIATE',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT x',
  'RELEASE x',
  'ROLLBACK TO x',
];

describe('transaction control through the client (spec 2026-10-04, B7)', () => {
  // Falsifiable: delete the set_authorizer call in src/worker/worker.ts — every
  // row reads 'ran' or a code other than AUTH. And: delete the controlSql check
  // on a cache hit — 'BEGIN IMMEDIATE', cached by the transaction before it, runs.
  it('refuses every form of it, cached or not', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (0)');
      });
      const results: [string, string][] = [];
      for (const sql of CONTROL)
        results.push([sql, await outcome(db.write(sql))]);
      expect(results).toEqual(CONTROL.map((sql) => [sql, REFUSED]));
      await expect(db.write('BEGIN')).rejects.toThrow(/db\.transaction\(\)/);
    } finally {
      await db.close();
    }
  });

  it('refuses it inside a compound string, after running what precedes it', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      expect(await outcome(db.write('INSERT INTO t VALUES (5); BEGIN'))).toBe(
        REFUSED,
      );
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 5 }]);
    } finally {
      await db.close();
    }
  });

  it('lets through what only looks like control', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      expect(
        await outcome(
          db.write("SELECT CASE WHEN 1 THEN 'BEGIN' ELSE 0 END AS c"),
        ),
      ).toBe('ran');
      expect(
        await outcome(db.write('INSERT OR ROLLBACK INTO t VALUES (6)')),
      ).toBe('ran');
      expect(
        await outcome(
          db.write('CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END'),
        ),
      ).toBe('ran');
    } finally {
      await db.close();
    }
  });
});

describe('transaction control inside a transaction (spec 2026-10-04, B7)', () => {
  it('refuses it, and the transaction goes on', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const inside = [
        'SAVEPOINT u',
        'RELEASE u',
        'ROLLBACK TO u',
        'COMMIT',
        'BEGIN',
      ];
      const results: [string, string][] = [];
      let message = '';
      await db.transaction(async (tx) => {
        for (const sql of inside)
          results.push([sql, await outcome(tx.write(sql))]);
        message = await tx.write('SAVEPOINT u').then(
          () => '',
          (e: Error) => e.message,
        );
        await tx.write('INSERT INTO t VALUES (1)');
      });
      expect(results).toEqual(inside.map((sql) => [sql, REFUSED]));
      expect(message).toMatch(/tx\.savepoint\(\)/);
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 1 }]);
    } finally {
      await db.close();
    }
  });
});

describe('what the guard lets through (spec 2026-10-04, D9)', () => {
  // Falsifiable: drop the `uncached` forwarding in src/pool.ts, or the
  // `options?.uncached` branch in worker.ts query() — the second SAVEPOINT reads 0.
  it('prepares every savepoint operation afresh, and caches BEGIN IMMEDIATE', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      for (let i = 0; i < 2; i++)
        await db.transaction(async (tx) => {
          const sp = await tx.savepoint('x');
          await sp.release();
        });
      const queries = (db.debug as ClientDebugState).requests.flatMap(
        (r) => r.queries,
      );
      const prepared = (sql: string) =>
        queries.filter((q) => q.sql === sql).map((q) => q.prepared);
      expect(prepared('SAVEPOINT "x"')).toEqual([1, 1]);
      expect(prepared('RELEASE "x"')).toEqual([1, 1]);
      expect(prepared('BEGIN IMMEDIATE').at(-1)).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('a failed __bsq_sp conclusion (spec 2026-09-11 amendment, kept by spec 2026-10-04 § 7)', () => {
  // The scenario a consumer could reach is gone with the guard, so the test
  // injects a conclusion with no savepoint open, at the protocol level.
  // Falsifiable: remove `await control('ROLLBACK')` from the conclude/open catch
  // in src/worker/worker.ts — the transaction then goes on and commits row 1.
  it('rolls the whole transaction back, and the transaction dies', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const worker = records[0]?.worker;
      if (!worker) throw new Error('no worker was intercepted');
      const post = worker.postMessage.bind(worker);
      let armed = false;
      worker.postMessage = (message: unknown, ...rest: unknown[]) => {
        const m = message as {
          type?: string;
          sql?: string;
          options?: Record<string, unknown>;
        };
        if (
          armed &&
          m.type === 'query' &&
          m.sql === 'INSERT INTO t VALUES (2)'
        ) {
          armed = false;
          m.options = { ...m.options, savepoint: { conclude: 'release' } };
        }
        return (post as (m: unknown, ...r: unknown[]) => void)(
          message,
          ...rest,
        );
      };
      let caught: unknown;
      const result = await db
        .transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          armed = true;
          caught = await tx.write('INSERT INTO t VALUES (2)').catch((e) => e);
        })
        .catch((e) => e);
      expect((caught as Error).message).toMatch(/no such savepoint/);
      expect(result).toBeInstanceOf(Error);
      expect(await db.read('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
