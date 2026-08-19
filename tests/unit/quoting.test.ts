import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import {
  assertColumnType,
  assertGeneratedExpression,
  quoteIdent,
  renderPragmas,
} from '../../src/utils';

describe('quoteIdent', () => {
  it('wraps a plain identifier in double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  it('doubles an internal double quote', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it('preserves case', () => {
    expect(quoteIdent('MyTable')).toBe('"MyTable"');
  });

  it('neutralises a statement-breaking name', () => {
    // The whole point: this must become one identifier, not two statements.
    expect(quoteIdent('t"; DROP TABLE users; --')).toBe(
      '"t""; DROP TABLE users; --"',
    );
  });

  it('rejects a NUL character', () => {
    expect(() => quoteIdent('a\0b')).toThrow(SQLiteError);
    expect(() => quoteIdent('a\0b')).toThrow(/INVALID_IDENTIFIER|NUL/);
  });

  it('rejects an empty identifier', () => {
    expect(() => quoteIdent('')).toThrow(SQLiteError);
  });
});

describe('assertColumnType', () => {
  const accepted = ['INTEGER', 'TEXT', 'VARCHAR(255)', 'DECIMAL(10, 2)'];
  for (const type of accepted) {
    it(`accepts ${type}`, () => {
      expect(assertColumnType(type, 'col')).toBe(type);
    });
  }

  const rejected = [
    'INTEGER); DROP TABLE users; --',
    "TEXT DEFAULT 'x'",
    'INTEGER,',
    '',
  ];
  for (const type of rejected) {
    it(`rejects ${JSON.stringify(type)}`, () => {
      expect(() => assertColumnType(type, 'col')).toThrow(SQLiteError);
    });
  }

  it('names the offending column', () => {
    expect(() => assertColumnType('bad;', 'price')).toThrow(/price/);
  });
});

describe('assertGeneratedExpression', () => {
  it('accepts a parenthesised expression', () => {
    expect(assertGeneratedExpression('(base * 2)', 'doubled')).toBe(
      '(base * 2)',
    );
  });

  it('rejects an unparenthesised expression', () => {
    expect(() => assertGeneratedExpression('base * 2', 'doubled')).toThrow(
      SQLiteError,
    );
  });

  it('rejects a statement separator', () => {
    expect(() =>
      assertGeneratedExpression('(1; DROP TABLE users)', 'doubled'),
    ).toThrow(SQLiteError);
  });
});

describe('renderPragmas', () => {
  it('renders an integer value as-is', () => {
    expect(renderPragmas({ busy_timeout: '5000' })).toEqual([
      'PRAGMA busy_timeout=5000',
    ]);
  });

  it('renders a bare word as-is', () => {
    expect(renderPragmas({ journal_mode: 'WAL' })).toEqual([
      'PRAGMA journal_mode=WAL',
    ]);
  });

  it('re-escapes a quoted string literal', () => {
    expect(renderPragmas({ some_key: "'it''s fine'" })).toEqual([
      "PRAGMA some_key='it''s fine'",
    ]);
  });

  it('renders one statement per entry', () => {
    expect(
      renderPragmas({ journal_mode: 'WAL', synchronous: 'NORMAL' }),
    ).toEqual(['PRAGMA journal_mode=WAL', 'PRAGMA synchronous=NORMAL']);
  });

  const badKeys = ['journal mode', 'journal_mode; DROP TABLE t', '1_mode', ''];
  for (const key of badKeys) {
    it(`rejects the key ${JSON.stringify(key)}`, () => {
      expect(() => renderPragmas({ [key]: 'WAL' })).toThrow(
        /INVALID_PRAGMA|pragma/i,
      );
    });
  }

  const badValues = ['WAL; DROP TABLE t', 'WAL OFF', '(1)'];
  for (const value of badValues) {
    it(`rejects the value ${JSON.stringify(value)}`, () => {
      expect(() => renderPragmas({ journal_mode: value })).toThrow(
        /journal_mode/,
      );
    });
  }
});
