import { describe, expect, it } from '@rstest/core';
import { isWriteQuery, sqlParams } from '../../src/utils';

describe('isWriteQuery', () => {
  describe('DML write operations', () => {
    it('returns true for INSERT', () => {
      expect(isWriteQuery('INSERT INTO t VALUES (?)')).toBe(true);
    });
    it('returns true for REPLACE', () => {
      expect(isWriteQuery('REPLACE INTO t VALUES (?)')).toBe(true);
    });
    it('returns true for UPDATE', () => {
      expect(isWriteQuery('UPDATE t SET x = 1')).toBe(true);
    });
    it('returns true for DELETE', () => {
      expect(isWriteQuery('DELETE FROM t WHERE id = 1')).toBe(true);
    });
  });

  describe('DDL write operations', () => {
    it('returns true for CREATE TABLE', () => {
      expect(isWriteQuery('CREATE TABLE t (id INTEGER)')).toBe(true);
    });
    it('returns true for DROP TABLE', () => {
      expect(isWriteQuery('DROP TABLE t')).toBe(true);
    });
  });

  describe('PRAGMA, ATTACH, DETACH (D3 extension)', () => {
    it('returns true for PRAGMA with assignment', () => {
      expect(isWriteQuery('PRAGMA journal_mode = WAL')).toBe(true);
    });
    it('returns true for PRAGMA read-only variant (conservative routing)', () => {
      expect(isWriteQuery('PRAGMA table_info(foo)')).toBe(true);
    });
    it('returns true for ATTACH', () => {
      expect(isWriteQuery('ATTACH "other.db" AS other')).toBe(true);
    });
    it('returns true for DETACH', () => {
      expect(isWriteQuery('DETACH other')).toBe(true);
    });
  });

  describe('read-only queries', () => {
    it('returns false for SELECT', () => {
      expect(isWriteQuery('SELECT * FROM t')).toBe(false);
    });
    it('returns false for WITH...SELECT CTE', () => {
      expect(isWriteQuery('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(
        false,
      );
    });
  });

  describe('CTE write operations', () => {
    it('returns true for WITH...INSERT CTE', () => {
      expect(
        isWriteQuery('WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte'),
      ).toBe(true);
    });
  });

  describe('case insensitivity (regex flag i)', () => {
    it('returns true for lowercase insert', () => {
      expect(isWriteQuery('insert into t values (1)')).toBe(true);
    });
    it('returns true for lowercase pragma', () => {
      expect(isWriteQuery('pragma table_info(foo)')).toBe(true);
    });
    it('returns true for lowercase create', () => {
      expect(isWriteQuery('create table t (id integer)')).toBe(true);
    });
  });
});

describe('sqlParams', () => {
  it('returns ?001 for first param', () => {
    const p = sqlParams();
    expect(p.addParam('alice')).toBe('?001');
  });

  it('returns ?002 for second unique param', () => {
    const p = sqlParams();
    p.addParam('alice');
    expect(p.addParam('bob')).toBe('?002');
  });

  it('deduplicates equal values', () => {
    const p = sqlParams();
    p.addParam('alice');
    p.addParam('bob');
    expect(p.addParam('alice')).toBe('?001');
  });

  it('params array contains only unique values in insertion order', () => {
    const p = sqlParams();
    p.addParam('alice');
    p.addParam('bob');
    p.addParam('alice');
    expect(p.params).toEqual(['alice', 'bob']);
    expect(p.params.length).toBe(2);
  });

  it('deduplicates numeric values', () => {
    const p = sqlParams();
    expect(p.addParam(42)).toBe('?001');
    expect(p.addParam(42)).toBe('?001');
    expect(p.params.length).toBe(1);
  });

  it('addParamArray maps and deduplicates', () => {
    const p = sqlParams();
    const result = p.addParamArray(['x', 'y', 'x']);
    expect(result).toBe('?001,?002,?001');
    expect(p.params.length).toBe(2);
  });

  it('each sqlParams() call creates an independent factory', () => {
    const p1 = sqlParams();
    const p2 = sqlParams();
    p1.addParam('shared');
    expect(p2.addParam('shared')).toBe('?001');
    expect(p2.params.length).toBe(1);
  });
});
