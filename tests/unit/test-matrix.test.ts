import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatCell, parseMatrixReport } from '../../scripts/test-matrix.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Fixtures carry only the fields `parseMatrixReport` reads of Vitest's JSON
 * reporter (`--reporter=json`); the shapes were checked against a real report.
 */
const report = (files: object[], success: boolean) =>
  JSON.stringify({
    success,
    startTime: 1_000,
    numTotalTests: 0,
    testResults: files,
  });
const file = (
  name: string,
  tests: { title: string; status: string; failureMessages?: string[] }[],
  extra: object = {},
) => ({
  name: join(ROOT, name),
  startTime: 1_000,
  endTime: 53_000,
  status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
  message: '',
  assertionResults: tests.map((t) => ({
    ancestorTitles: ['d'],
    title: t.title,
    status: t.status,
    failureMessages: t.failureMessages ?? [],
  })),
  ...extra,
});

const PASSING = report(
  [
    file('tests/browser/a.test.ts', [
      { title: 'x', status: 'passed' },
      { title: 'y', status: 'skipped' },
    ]),
  ],
  true,
);
const FAILING = report(
  [
    file('tests/browser/a.test.ts', [
      {
        title: 'x',
        status: 'failed',
        failureMessages: ['AssertionError: expected 1 to be 2'],
      },
    ]),
  ],
  false,
);
const NOT_RUNNABLE = report(
  [
    file('tests/browser/a.test.ts', [
      {
        title: 'x',
        status: 'failed',
        failureMessages: ['TARGET_NOT_RUNNABLE: needs opfs'],
      },
    ]),
  ],
  false,
);
const MIXED = report(
  [
    file('tests/browser/a.test.ts', [
      {
        title: 'x',
        status: 'failed',
        failureMessages: ['TARGET_NOT_RUNNABLE: needs opfs'],
      },
      {
        title: 'y',
        status: 'failed',
        failureMessages: ['AssertionError: expected 1 to be 2'],
      },
    ]),
  ],
  false,
);
// A page crash: the file failed with no failed test, the reason in `message`.
const CRASHED = report(
  [
    file('tests/browser/a.test.ts', [{ title: 'x', status: 'passed' }], {
      status: 'failed',
      message: 'Browser connection was closed while running tests',
    }),
  ],
  false,
);
// Every failed test is not-runnable, and the file ALSO failed at file level.
const NOT_RUNNABLE_AND_CRASHED = report(
  [
    file(
      'tests/browser/a.test.ts',
      [
        {
          title: 'x',
          status: 'failed',
          failureMessages: ['TARGET_NOT_RUNNABLE: needs opfs'],
        },
      ],
      { message: 'Browser connection was closed while running tests' },
    ),
  ],
  false,
);

describe('parseMatrixReport', () => {
  it('reads a passing report', () => {
    expect(parseMatrixReport(PASSING)).toEqual({
      status: 'passed',
      tests: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      files: 1,
      seconds: 52,
    });
  });

  it('reads a failing report', () => {
    expect(parseMatrixReport(FAILING)).toMatchObject({
      status: 'failed',
      failed: 1,
    });
  });

  it('classifies a report as not-runnable only when every failure is TARGET_NOT_RUNNABLE', () => {
    expect(parseMatrixReport(NOT_RUNNABLE)).toEqual({
      status: 'not-runnable',
      seconds: 52,
    });
  });

  it('keeps a real failure that comes with TARGET_NOT_RUNNABLE ones', () => {
    // Falsifiable: classifying this as "not-runnable" would hide a real
    // failure behind the TARGET_NOT_RUNNABLE one.
    expect(parseMatrixReport(MIXED)).toMatchObject({
      status: 'failed',
      failed: 2,
    });
  });

  it('does not hide a file-level failure behind not-runnable tests', () => {
    // Falsifiable: deciding not-runnable before reading `message` reports
    // this cell as not-runnable and drops the page crash.
    expect(parseMatrixReport(NOT_RUNNABLE_AND_CRASHED)).toMatchObject({
      status: 'failed',
      unhandled: [
        'tests/browser/a.test.ts: Browser connection was closed while running tests',
      ],
    });
  });

  it('classifies no report, or one that does not parse, as timed out', () => {
    // A killed run never writes its report: absence is the signal.
    expect(parseMatrixReport('')).toEqual({ status: 'timed-out' });
    expect(parseMatrixReport('{')).toEqual({ status: 'timed-out' });
    // Valid JSON that is no report must not throw out of the matrix run.
    expect(parseMatrixReport('{}')).toEqual({ status: 'timed-out' });
    expect(parseMatrixReport('null')).toEqual({ status: 'timed-out' });
  });

  it('keeps the reason of a failed file whose tests all passed', () => {
    expect(parseMatrixReport(CRASHED)).toMatchObject({
      status: 'failed',
      failed: 0,
      unhandled: [
        'tests/browser/a.test.ts: Browser connection was closed while running tests',
      ],
    });
  });
});

describe('formatCell', () => {
  it('prints counts, files and time for a passing cell', () => {
    expect(formatCell(parseMatrixReport(PASSING))).toBe(
      '1/0/1 · 1 files · 52s',
    );
  });

  it('says FAIL, and why, for a failed cell with no failed test', () => {
    // Falsifiable: print only the counts and this cell reads 1/0/0, which
    // is how a page crash passed for green in the table.
    expect(formatCell(parseMatrixReport(CRASHED))).toContain(
      'FAIL: tests/browser/a.test.ts: Browser connection',
    );
  });
});
