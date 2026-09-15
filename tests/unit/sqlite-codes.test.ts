import { describe, expect, it } from '@rstest/core';
import * as wa from 'wa-sqlite/src/sqlite-constants.js';
import { SQLITE_CODES, SQLITE_EXTENDED_CODES } from '../../src/sqlite-codes';

/**
 * docs/superpowers/specs/2026-09-14-statement-errors-design.md §4 (D8). The
 * tables are transcribed, so what can be checked mechanically is checked here.
 */
const constants = wa as unknown as Record<string, number>;

describe('SQLITE_CODES and SQLITE_EXTENDED_CODES', () => {
  // Falsifiable: mistype any value that wa-sqlite also defines — e.g.
  // CONSTRAINT_UNIQUE: 2068.
  it('agree with every result code wa-sqlite also defines', () => {
    const shared = [
      ...Object.entries(SQLITE_CODES),
      ...Object.entries(SQLITE_EXTENDED_CODES),
    ].filter(([name]) => `SQLITE_${name}` in constants);
    // 65 on the vendored wa-sqlite (v1.1.2). Guards the lookup, not the
    // tables: a broken import would otherwise let this pass having compared
    // nothing.
    expect(shared.length).toBeGreaterThanOrEqual(65);
    expect(
      shared.filter(([name, value]) => constants[`SQLITE_${name}`] !== value),
    ).toEqual([]);
  });

  // Falsifiable: move one code into the other table — e.g. CONSTRAINT_UNIQUE
  // into SQLITE_CODES.
  it('keep primary and extended codes apart', () => {
    const primary: number[] = Object.values(SQLITE_CODES);
    const extended: number[] = Object.values(SQLITE_EXTENDED_CODES);
    expect(primary.filter((v) => v >= 256)).toEqual([]);
    expect(extended.filter((v) => v < 256)).toEqual([]);
  });

  // Falsifiable: key an extended code under the wrong family — e.g.
  // IOERR_READ: 267, CORRUPT's low byte. Checks the family the NAME announces,
  // not merely that some primary code matches the low byte.
  it("give every extended code its name's family as low byte", () => {
    const family = SQLITE_CODES as Record<string, number>;
    expect(
      Object.entries(SQLITE_EXTENDED_CODES).filter(
        ([name, value]) =>
          family[name.slice(0, name.indexOf('_'))] !== (value & 0xff),
      ),
    ).toEqual([]);
  });

  // Falsifiable: drop one entry, or either Object.freeze.
  it('hold the 31 primary and 82 extended codes of SQLite 3.53.0, frozen', () => {
    expect(Object.keys(SQLITE_CODES)).toHaveLength(31);
    expect(Object.keys(SQLITE_EXTENDED_CODES)).toHaveLength(82);
    expect(Object.isFrozen(SQLITE_CODES)).toBe(true);
    expect(Object.isFrozen(SQLITE_EXTENDED_CODES)).toBe(true);
  });
});
