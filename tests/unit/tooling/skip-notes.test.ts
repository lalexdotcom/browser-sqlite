import { describe, expect, it } from 'vitest';
import {
  formatNotExercised,
  formatRetried,
  formatSkipNotes,
} from '../../../scripts/skip-notes.ts';

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

describe('formatRetried', () => {
  it('prints nothing when no test needed its retry', () => {
    expect(
      formatRetried([{ file: FILE, test: 'a', cell: 'chrome · A/x' }]),
    ).toBe('');
  });

  it('names each test that passed on its retry, with its cells', () => {
    // Falsifiable: leave it out of the merged report and a pass on retry
    // looks like any other pass once the run ends.
    expect(
      formatRetried([
        { file: FILE, test: 'd > t', cell: 'firefox · A/x', retried: 1 },
        { file: FILE, test: 'd > t', cell: 'chrome · A/x', retried: 1 },
        { file: FILE, test: 'd > u', cell: 'chrome · A/x' },
      ]),
    ).toBe(
      [
        '',
        'Passed on retry (1 test) — it ran out of time first: look at it',
        `  ${FILE} › d > t`,
        '    on chrome · A/x, firefox · A/x',
        '',
      ].join('\n'),
    );
  });
});

describe('formatNotExercised', () => {
  it('prints nothing when every case was reached', () => {
    expect(
      formatNotExercised([{ file: FILE, test: 'a', cell: 'chrome · A/x' }]),
    ).toBe('');
  });

  it('names each test whose case was not reached, with why and where', () => {
    // Falsifiable: leave it out of the merged report and the test reads as a
    // pass that proved its subject.
    expect(
      formatNotExercised([
        {
          file: FILE,
          test: 'd > t',
          cell: 'firefox · A/x',
          notExercised: 'the verdict was not parked',
        },
        {
          file: FILE,
          test: 'd > t',
          cell: 'chrome · A/x',
          notExercised: 'the verdict was not parked',
        },
        { file: FILE, test: 'd > u', cell: 'chrome · A/x' },
      ]),
    ).toBe(
      [
        '',
        'Not exercised (1 test) — a precondition was not reached, nothing was proven: look at it',
        '  the verdict was not parked',
        `    ${FILE} › d > t`,
        '      on chrome · A/x, firefox · A/x',
        '',
      ].join('\n'),
    );
  });
});
