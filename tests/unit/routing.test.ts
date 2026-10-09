import { describe, expect, it } from '@rstest/core';
import { isReadQuery } from '../../src/utils';

describe('routing (W-route)', () => {
  const writes = [
    // Statements that were misrouted by the old blocklist
    'VACUUM',
    'ALTER TABLE t ADD COLUMN c INTEGER',
    'ANALYZE',
    'REINDEX',
    'SAVEPOINT sp1',
    'BEGIN',
    // Standard writes
    'INSERT INTO t VALUES (1)',
    'CREATE TABLE t (a INTEGER)',
    // Unknown statement: allowlist fails safe toward writer
    'FROBNICATE t',
    // CTE with a write body
    'WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte',
    // Multi-statement: write after semicolon must NOT route to the read pool
    'SELECT 1; INSERT INTO t VALUES (1)',
    'SELECT 1; DROP TABLE t',
    'VALUES (1); DELETE FROM t',
    'EXPLAIN SELECT 1; UPDATE t SET x = 1',
    'WITH x AS (SELECT 1) SELECT * FROM x; DROP TABLE t',
    // Accepted cost: a read keyword in a string literal or EXPLAIN arg routes to writer
    "SELECT 'INSERT'",
    'EXPLAIN INSERT INTO t VALUES (1)',
  ];
  for (const sql of writes) {
    it(`routes to the writer: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(false);
    });
  }

  const reads = [
    'SELECT 1',
    '  select * from t',
    'EXPLAIN SELECT 1',
    'VALUES (1, 2)',
    // CTE whose body is a pure SELECT
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'WITH cte AS (SELECT 1) SELECT * FROM cte',
    // Column named inserted_at must NOT match \bINSERT\b — word boundary test
    'WITH x AS (SELECT inserted_at FROM t) SELECT * FROM x',
    'SELECT * FROM t',
  ];
  for (const sql of reads) {
    it(`routes to a reader: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(true);
    });
  }

  const readPragmas = [
    'PRAGMA journal_mode',
    'pragma  user_version ',
    'PRAGMA main.page_count',
    'PRAGMA journal_mode;',
  ];
  for (const sql of readPragmas) {
    it(`routes to the read pool: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(true);
    });
  }

  const writePragmas = [
    'PRAGMA journal_mode=WAL',
    'PRAGMA journal_mode = WAL',
    'PRAGMA journal_mode; DROP TABLE t',
    'PRAGMA table_info(foo); DROP TABLE t',
    'PRAGMA optimize; VACUUM',
    // An argument is an assignment outside the introspection list.
    'PRAGMA user_version(5)',
    'PRAGMA main.cache_size(10)',
    'PRAGMA optimize(0x10002)',
    'PRAGMA wal_checkpoint(PASSIVE)',
    // The argument grammar admits one name or number, closed, and nothing after.
    'PRAGMA table_info(foo) ; DROP TABLE t',
    "PRAGMA table_info('foo'); DROP TABLE t",
    "PRAGMA table_info('a'); DROP TABLE t; --')",
    'PRAGMA table_info("foo)',
    'PRAGMA table_info(foo',
    'PRAGMA table_info(a, b)',
    'PRAGMA table_info()',
    'PRAGMA table_info = foo',
  ];
  for (const sql of writePragmas) {
    it(`routes to the writer: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(false);
    });
  }

  // Probed on wa-sqlite's SQLite 3.53.0 (2026-10-09): each runs on a read-only
  // connection, where user_version(5) fails.
  const introspectionPragmas = [
    'PRAGMA table_info(foo)',
    'PRAGMA main.table_info("we""ird")',
    "PRAGMA table_xinfo('foo')",
    'PRAGMA table_list(foo)',
    'PRAGMA index_list([foo])',
    'PRAGMA index_info(i)',
    'PRAGMA index_xinfo(`i`)',
    'PRAGMA foreign_key_list(foo)',
    'PRAGMA foreign_key_check(foo)',
    'PRAGMA integrity_check(10)',
    'PRAGMA quick_check(foo)',
    'pragma  Table_Info ( foo ) ;',
  ];
  for (const sql of introspectionPragmas) {
    it(`routes to the read pool: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(true);
    });
  }
});
