import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { SQLiteError } from '../../src/errors';
import { SQLITE_CODES, SQLITE_EXTENDED_CODES } from '../../src/sqlite-codes';
import { createTestClient } from './helpers';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md: a statement
 * SQLite refuses rejects with STATEMENT_FAILED, carrying SQLite's primary
 * result code on `sqliteCode` and its extended one on `sqliteExtendedCode`.
 *
 * Every build, because each has its own export of
 * `sqlite3_extended_errcode`. `MemoryVFS` declares all three and needs no
 * cleanup; `poolSize: 1` because its pages live in the worker that opened it.
 */

const BUILDS = ['sync', 'async', 'jspi'] as const;

const CONSTRAINTS = [
  {
    name: 'UNIQUE',
    setup: ['CREATE TABLE u (a INTEGER UNIQUE)', 'INSERT INTO u VALUES (1)'],
    failing: 'INSERT INTO u VALUES (1)',
    extended: SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE,
    message: /UNIQUE constraint failed: u\.a/,
  },
  {
    name: 'FOREIGN KEY',
    setup: [
      'CREATE TABLE p (id INTEGER PRIMARY KEY)',
      'CREATE TABLE c (p INTEGER REFERENCES p (id))',
    ],
    failing: 'INSERT INTO c VALUES (42)',
    extended: SQLITE_EXTENDED_CODES.CONSTRAINT_FOREIGNKEY,
    message: /FOREIGN KEY constraint failed/,
  },
  {
    name: 'NOT NULL',
    setup: ['CREATE TABLE n (a INTEGER NOT NULL)'],
    failing: 'INSERT INTO n VALUES (NULL)',
    extended: SQLITE_EXTENDED_CODES.CONSTRAINT_NOTNULL,
    message: /NOT NULL constraint failed: n\.a/,
  },
];

/** Fills `big` past any small `max_page_count`. TX-M1's statement. */
const FILL_BIG =
  "INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 20000) SELECT printf('%0500d', x) FROM c";

const memoryClient = (
  build: (typeof BUILDS)[number],
  pragmas?: Record<string, string>,
) =>
  createTestClient({
    vfs: 'MemoryVFS',
    build,
    poolSize: 1,
    ...(pragmas ? { pragmas } : {}),
  });

describe('a failed statement carries SQLite codes', () => {
  for (const build of BUILDS) {
    // Falsifiable: drop the STATEMENT_FAILED branch of statementError in
    // src/pool.ts — a plain Error arrives. Drop the stamp in the worker's
    // `run` — sqliteExtendedCode is undefined.
    for (const c of CONSTRAINTS) {
      it(`${c.name} through write() (${build})`, async () => {
        const db = await memoryClient(build, { foreign_keys: 'ON' });
        try {
          for (const sql of c.setup) await db.write(sql);
          const error = await db.write(c.failing).catch((e) => e);
          expect(error).toBeInstanceOf(SQLiteError);
          expect(error).toMatchObject({
            code: 'STATEMENT_FAILED',
            name: 'STATEMENT_FAILED',
            sqliteCode: SQLITE_CODES.CONSTRAINT,
            sqliteExtendedCode: c.extended,
          });
          expect(error.message).toMatch(c.message);
        } finally {
          await db.close();
        }
      });
    }

    // The prepare path: no statement exists yet, so `run` never sees this
    // error. A missing collation is the prepare failure that has a subtype,
    // so it is the one that can falsify SOME prepare-level stamp. This SQL is
    // a single statement, so it takes the fresh branch's own inner catch,
    // which stamps first — the outer stamp would read the same value there
    // (`??=`), so this falsifies only the removal of BOTH prepare-level
    // stamps. The test below is what falsifies the outer one alone.
    it(`a missing collation through read(), the prepare path (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        const error = await db
          .read("SELECT 'a' = 'b' COLLATE nosuch")
          .catch((e) => e);
        expect(error).toMatchObject({
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.ERROR,
          sqliteExtendedCode: SQLITE_EXTENDED_CODES.ERROR_MISSING_COLLSEQ,
        });
        expect(error.message).toMatch(/no such collation sequence: nosuch/);
      } finally {
        await db.close();
      }
    });

    // The uncacheable branch. A multi-statement string's first run takes the
    // fresh branch and marks the string uncacheable; its second run prepares
    // through wa-sqlite's own statements() generator, where only query's outer
    // catch stamps. Falsifiable: drop that outer stamp — the second run's
    // sqliteExtendedCode is undefined. The fresh branch's own stamp (first run)
    // has no falsifier: nothing runs between that failure and the outer catch,
    // which would read the same value.
    it(`a later statement's prepare failure, fresh then uncacheable (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        const sql = "SELECT 1; SELECT 'a' = 'b' COLLATE nosuch";
        const expected = {
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.ERROR,
          sqliteExtendedCode: SQLITE_EXTENDED_CODES.ERROR_MISSING_COLLSEQ,
        };
        const fresh = await db.read(sql).catch((e) => e);
        expect(fresh).toMatchObject(expected);
        const uncacheable = await db.read(sql).catch((e) => e);
        expect(uncacheable).toMatchObject(expected);
      } finally {
        await db.close();
      }
    });

    // Spec D9: SQLite reports no subtype for a syntax error, so there is no
    // sqliteExtendedCode. Falsifiable: make subtypeOf in src/pool.ts return
    // data.sqliteExtendedCode unconditionally — it arrives as 1.
    it(`a syntax error has no subtype (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        const error = await db.read('SELECT * FROM WHERE').catch((e) => e);
        expect(error).toMatchObject({
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.ERROR,
        });
        expect(error.sqliteExtendedCode).toBeUndefined();
        expect(error.message).toMatch(/syntax error/);
      } finally {
        await db.close();
      }
    });

    // TX-M1 (mem:measurements, 2026-09-10): this error reached the client with
    // neither `code` nor `sqliteCode`. SQLite undoes the statement alone, so
    // the transaction goes on and commits.
    it(`SQLITE_FULL inside a transaction (${build})`, async () => {
      const db = await memoryClient(build);
      try {
        await db.write('CREATE TABLE t (a INTEGER)');
        await db.write('CREATE TABLE big (x TEXT)');
        const pages =
          (await db.read<{ page_count: number }>('PRAGMA page_count'))[0]
            ?.page_count ?? 0;
        await db.write(`PRAGMA max_page_count = ${pages + 3}`);
        let caught: unknown;
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await tx.write(FILL_BIG).catch((e) => e);
          await tx.write('INSERT INTO t VALUES (2)');
        });
        expect(caught).toMatchObject({
          code: 'STATEMENT_FAILED',
          sqliteCode: SQLITE_CODES.FULL,
        });
        // SQLite has no subtype for a full database (spec D9).
        expect(
          (caught as { sqliteExtendedCode?: number }).sqliteExtendedCode,
        ).toBeUndefined();
        expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
          { a: 1 },
          { a: 2 },
        ]);
      } finally {
        await db.close();
      }
    });
  }
});

describe('bulkWrite', () => {
  // SQLiteBulkWriteError already keeps the failed batch as `cause`; this pins
  // what that cause now is. Falsifiable: drop the STATEMENT_FAILED branch of
  // statementError — the cause is a plain Error.
  it('keeps the failed statement as the cause of BULK_WRITE_FAILED', async () => {
    const db = await memoryClient('sync');
    try {
      await db.write('CREATE TABLE k (k INTEGER UNIQUE)');
      const bulk = db.bulkWrite('k', ['k']);
      bulk.enqueue({ k: 1 });
      bulk.enqueue({ k: 1 });
      const error = await bulk.close().catch((e) => e);
      expect(error.code).toBe('BULK_WRITE_FAILED');
      expect(error.cause).toMatchObject({
        code: 'STATEMENT_FAILED',
        sqliteCode: SQLITE_CODES.CONSTRAINT,
        sqliteExtendedCode: SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE,
      });
    } finally {
      await db.close();
    }
  });
});

describe('a file that is not a database', () => {
  /** An OPFS file of 4 KiB of 'A' — what an `opfs-path` VFS opens by name. */
  const garbageFile = async () => {
    const file = `statement-errors-${crypto.randomUUID()}`;
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(4096).fill(0x41));
    await writable.close();
    return { file, remove: () => root.removeEntry(file).catch(() => {}) };
  };

  // `OPFSAdaptiveVFS` declares no default pragma, so a `pragmas` entry is
  // what makes the open read the file. Falsifiable: drop `sqliteCode` from
  // the WORKER_CRASHED built in startupError.
  it('fails the open with WORKER_CRASHED carrying NOTADB when a pragma reads it', async () => {
    const { file, remove } = await garbageFile();
    const db = createSQLiteClient(file, {
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 1,
      pragmas: { user_version: '1' },
    });
    onTestFinished(async () => {
      await db.close();
      await remove();
    });
    const error = await db.read('SELECT 1').catch((e) => e);
    expect(error).toMatchObject({
      code: 'WORKER_CRASHED',
      sqliteCode: SQLITE_CODES.NOTADB,
    });
    expect(error.sqliteExtendedCode).toBeUndefined();
  });

  // Without one, the open is lazy and succeeds: the first statement that
  // reads the schema is what fails.
  it('fails the first statement with STATEMENT_FAILED when nothing reads it at open', async () => {
    const { file, remove } = await garbageFile();
    const db = createSQLiteClient(file, {
      vfs: 'OPFSAdaptiveVFS',
      poolSize: 1,
    });
    onTestFinished(async () => {
      await db.close();
      await remove();
    });
    const error = await db
      .read('SELECT name FROM sqlite_schema')
      .catch((e) => e);
    expect(error).toMatchObject({
      code: 'STATEMENT_FAILED',
      sqliteCode: SQLITE_CODES.NOTADB,
    });
    // SQLite has no subtype for NOTADB (spec D9).
    expect(error.sqliteExtendedCode).toBeUndefined();
  });
});
