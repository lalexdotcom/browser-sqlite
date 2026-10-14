import { describe, expect, it } from 'vitest';
import { formatSkipNotes } from '../../../scripts/skip-notes.ts';

/**
 * A browser-defect skip shows its reason in every run's output
 * (`mem:conventions`); the merged default report prints a test line only for a
 * failed module, so `test-plan.ts` prints the reasons itself, from this.
 */

const GC = 'this browser was not launched with --expose-gc';
const FILE = 'tests/browser/abandon-gc.test.ts';

describe('formatSkipNotes', () => {
  it('prints nothing when no test skipped with a reason', () => {
    // Falsifiable: print the heading unconditionally and this goes red.
    expect(
      formatSkipNotes([
        { file: FILE, test: 'a', cell: 'chrome · A/x' },
        { file: FILE, test: 'b', cell: 'chrome · A/x' },
      ]),
    ).toBe('');
  });

  it('names a test skipped on every cell that ran it once, with the count', () => {
    // Falsifiable: list every cell instead and the matrix prints 44 of them.
    expect(
      formatSkipNotes([
        { file: FILE, test: 'd > t', cell: 'chrome · A/x', note: GC },
        { file: FILE, test: 'd > t', cell: 'firefox · A/x', note: GC },
      ]),
    ).toBe(
      [
        '',
        'Skipped with a reason (1 test)',
        `  ${GC}`,
        `    ${FILE} › d > t`,
        '      on every cell that ran it (2)',
        '',
      ].join('\n'),
    );
  });

  it('lists the cells when the test skipped on only some of them', () => {
    // Falsifiable: count only the skipped cells as the total and this reads
    // "every cell" for a test that ran elsewhere.
    expect(
      formatSkipNotes([
        { file: FILE, test: 't', cell: 'firefox · B/y', note: GC },
        { file: FILE, test: 't', cell: 'chrome · A/x' },
        { file: FILE, test: 't', cell: 'chrome · B/y', note: GC },
      ]),
    ).toBe(
      [
        '',
        'Skipped with a reason (1 test)',
        `  ${GC}`,
        `    ${FILE} › t`,
        '      on 2 of 3 cells: chrome · B/y, firefox · B/y',
        '',
      ].join('\n'),
    );
  });

  it('groups the tests under their reason, reasons and tests in order', () => {
    // Falsifiable: drop the grouping and a reason repeats once per test.
    expect(
      formatSkipNotes([
        { file: 'tests/browser/b.test.ts', test: 't', cell: 'c', note: 'zeta' },
        { file: FILE, test: 'u', cell: 'c', note: GC },
        { file: FILE, test: 't', cell: 'c', note: GC },
      ]),
    ).toBe(
      [
        '',
        'Skipped with a reason (3 tests)',
        `  ${GC}`,
        `    ${FILE} › t`,
        '      on every cell that ran it (1)',
        `    ${FILE} › u`,
        '      on every cell that ran it (1)',
        '  zeta',
        '    tests/browser/b.test.ts › t',
        '      on every cell that ran it (1)',
        '',
      ].join('\n'),
    );
  });
});
