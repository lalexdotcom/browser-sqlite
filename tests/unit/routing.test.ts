import { describe, expect, it } from '@rstest/core';
import { isReadQuery } from '../../src/utils';

describe('routing (W-route)', () => {
  const writes = [
    'VACUUM',
    'ALTER TABLE t ADD COLUMN c INTEGER',
    'ANALYZE',
    'REINDEX',
    'SAVEPOINT sp1',
    'BEGIN',
    'INSERT INTO t VALUES (1)',
    'CREATE TABLE t (a INTEGER)',
    // PRAGMA: safe direction — routed to writer even for read-only variants
    'PRAGMA table_info(foo)',
    // Unknown statement: allowlist fails safe toward writer
    'FROBNICATE t',
    // CTE with a write body: only the tail keyword determines the type
    'WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte',
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
    // CTE with nested CTE, no write keyword
    'WITH cte AS (SELECT 1) SELECT * FROM cte',
  ];
  for (const sql of reads) {
    it(`routes to a reader: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(true);
    });
  }
});
