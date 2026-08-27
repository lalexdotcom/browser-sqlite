import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import type { SQLiteBuild } from '../../src/types';
import {
  isWriteQuery,
  normalizeDatabaseFile,
  resolveWasmLocation,
  sqlParams,
} from '../../src/utils';

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

describe('normalizeDatabaseFile', () => {
  // Falsifiable: return `file` unchanged from normalizeDatabaseFile and the
  // first three cases go red — which is exactly the epoch registry splitting
  // one database into several keys.
  it('collapses spellings that address the same OPFS file', () => {
    expect(normalizeDatabaseFile('data/file')).toBe('data/file');
    expect(normalizeDatabaseFile('./data/file')).toBe('data/file');
    expect(normalizeDatabaseFile('/data/file')).toBe('data/file');
    expect(normalizeDatabaseFile('data\\file')).toBe('data/file');
    expect(normalizeDatabaseFile('data/../file')).toBe('file');
  });

  it('percent-encodes exactly as the VFS do', () => {
    expect(normalizeDatabaseFile('café')).toBe('caf%C3%A9');
    expect(normalizeDatabaseFile('caf%C3%A9')).toBe('caf%C3%A9');
  });

  it('keeps genuinely distinct names distinct', () => {
    expect(normalizeDatabaseFile('data//file')).toBe('data//file');
    expect(normalizeDatabaseFile('SQLite')).not.toBe(
      normalizeDatabaseFile('sqlite'),
    );
  });

  it('is idempotent, so re-normalizing in the VFS changes nothing', () => {
    const once = normalizeDatabaseFile('./data/file');
    expect(normalizeDatabaseFile(once)).toBe(once);
  });

  // Falsifiable: restore the absolute form (drop the `.replace(/^\//, '')`) and
  // this goes red — a 57-char name with a leading slash would normalize to 57
  // chars, one over the 56-char ceiling SQLite's `nPathname + 8 > mxPathname`
  // (mxPathname = 64, wa-sqlite/src/VFS.js:10) leaves for the open call.
  it('strips the leading slash so a 57-char name fits the 56-char open budget', () => {
    const input = '/' + 'x'.repeat(56); // 57 chars as written
    const normalized = normalizeDatabaseFile(input);
    expect(normalized.length).toBe(56);
  });
});

describe('resolveWasmLocation', () => {
  // A page URL with a directory and a document, so a page-relative value and an
  // absolute one cannot accidentally agree.
  const PAGE = 'https://app.example/dashboard/index.html';

  // Falsifiable: make the option resolve to anything when it is absent and this
  // goes red. It is the whole guarantee that the default path is untouched —
  // the worker only sets `locateFile` when this returns a value.
  it('returns undefined when the option is absent', () => {
    expect(resolveWasmLocation(undefined, 'sync', PAGE)).toBeUndefined();
  });

  it('anchors a relative base on the page, with or without the ./ prefix', () => {
    expect(resolveWasmLocation('wasm/', 'sync', PAGE)).toEqual({
      base: 'https://app.example/dashboard/wasm/',
    });
    expect(resolveWasmLocation('./wasm/', 'sync', PAGE)).toEqual({
      base: 'https://app.example/dashboard/wasm/',
    });
  });

  // Without the completion, URL resolution treats `wasm` as a document and
  // drops it, yielding `/static/wa-sqlite.wasm` — a plausible-looking 404.
  it('completes a missing trailing slash instead of dropping the last segment', () => {
    expect(resolveWasmLocation('/static/wasm', 'sync', PAGE)).toEqual({
      base: 'https://app.example/static/wasm/',
    });
  });

  it('is idempotent on a base that already ends with a slash', () => {
    expect(resolveWasmLocation('/static/wasm/', 'sync', PAGE)).toEqual(
      resolveWasmLocation('/static/wasm', 'sync', PAGE),
    );
  });

  it('lets an absolute path skip the page directory and a full URL skip the origin', () => {
    expect(resolveWasmLocation('/wasm', 'sync', PAGE)).toEqual({
      base: 'https://app.example/wasm/',
    });
    expect(resolveWasmLocation('https://cdn.example/w', 'sync', PAGE)).toEqual({
      base: 'https://cdn.example/w/',
    });
  });

  it('passes the resolved build to the callback and takes its answer as a file', () => {
    const seen: SQLiteBuild[] = [];
    const location = resolveWasmLocation(
      (build) => {
        seen.push(build);
        return `/assets/wa-sqlite-${build}.a1b2c3.wasm`;
      },
      'async',
      PAGE,
    );
    expect(seen).toEqual(['async']);
    expect(location).toEqual({
      file: 'https://app.example/assets/wa-sqlite-async.a1b2c3.wasm',
    });
  });

  // No slash is appended here: a callback names a file, and appending one would
  // turn a hashed asset into a directory that does not exist.
  it('resolves a relative answer from the callback against the page as well', () => {
    expect(resolveWasmLocation(() => 'w/x.wasm', 'jspi', PAGE)).toEqual({
      file: 'https://app.example/dashboard/w/x.wasm',
    });
  });

  it('throws a named INVALID_OPTION rather than deferring to an opaque open failure', () => {
    expect(() => resolveWasmLocation('https://', 'sync', PAGE)).toThrow(
      SQLiteError,
    );
    expect(() => resolveWasmLocation('https://', 'sync', PAGE)).toThrow(
      /https:\/\//,
    );
    expect(() => resolveWasmLocation(() => 'https://', 'sync', PAGE)).toThrow(
      SQLiteError,
    );
  });
});
