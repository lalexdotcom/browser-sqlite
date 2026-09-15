import { describe, expect, it } from '@rstest/core';
import * as wa from 'wa-sqlite/src/sqlite-constants.js';
import { SQLITE_CODES } from '../../src/sqlite-codes';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md §4. The list is
 * transcribed, so what can be checked mechanically is checked here.
 */
describe('SQLITE_CODES', () => {
  // Falsifiable: mistype any value that wa-sqlite also defines — e.g.
  // CONSTRAINT_UNIQUE: 2068.
  it('agrees with every result code wa-sqlite also defines', () => {
    const constants = wa as unknown as Record<string, number>;
    const shared = Object.entries(SQLITE_CODES).filter(
      ([name]) => `SQLITE_${name}` in constants,
    );
    // 65 on wa-sqlite 1.1.1. Guards the lookup, not the list: a broken import
    // would otherwise let this pass having compared nothing.
    expect(shared.length).toBeGreaterThanOrEqual(65);
    expect(
      shared.filter(([name, value]) => constants[`SQLITE_${name}`] !== value),
    ).toEqual([]);
  });

  // Falsifiable: give an extended code a low byte that is no primary code —
  // e.g. IOERR_READ: 267 + 0x100.
  it('maps every extended code onto a primary code of the list', () => {
    const values: number[] = Object.values(SQLITE_CODES);
    const primary = new Set(values.filter((v) => v < 256));
    expect(values.filter((v) => v >= 256 && !primary.has(v & 0xff))).toEqual(
      [],
    );
  });

  // Falsifiable: drop one entry, or the Object.freeze.
  it('holds the 113 result codes of SQLite 3.53.0, frozen', () => {
    expect(Object.keys(SQLITE_CODES)).toHaveLength(113);
    expect(Object.isFrozen(SQLITE_CODES)).toBe(true);
  });
});
