import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestCase, TestModule, TestSuite } from 'vitest/node';
import { ROOT } from '../../../scripts/parallel.ts';
import ProgressReporter, {
  failureEvent,
  inFlightReport,
  notExercisedEvent,
  retriedEvent,
} from '../../../scripts/progress-reporter.ts';

/**
 * Each Vitest process a planner starts reports its failed tests as they fail,
 * so a CI check run can show them before the cell ends
 * (docs/superpowers/specs/2026-11-03-ci-live-progress-design.md).
 */

const testCase = (
  state: string,
  errors?: { message?: string }[],
  fullName = 's > t',
  retryCount = 0,
) => ({
  fullName,
  module: { moduleId: join(ROOT, 'tests/browser/x.test.ts') },
  result: () => ({ state, ...(errors ? { errors } : {}) }),
  diagnostic: () => ({
    retryCount,
    flaky: state === 'passed' && retryCount > 0,
  }),
});

describe('failureEvent', () => {
  it('writes a failed test as one JSON line, with the first line of its error', () => {
    const line = failureEvent(
      testCase('failed', [{ message: 'AssertionError: a\n  at b' }]),
    );
    expect(line?.endsWith('\n')).toBe(true);
    expect(JSON.parse(line as string)).toEqual({
      file: 'tests/browser/x.test.ts',
      test: 's > t',
      message: 'AssertionError: a',
    });
  });

  it('writes nothing for a test that passed or skipped', () => {
    // Falsifiable: report every result and these become lines.
    expect(failureEvent(testCase('passed'))).toBeUndefined();
    expect(failureEvent(testCase('skipped'))).toBeUndefined();
  });

  it('writes an empty message for a failure with no error', () => {
    expect(JSON.parse(failureEvent(testCase('failed')) as string).message).toBe(
      '',
    );
  });
});

describe('retriedEvent', () => {
  it('writes a test that passed on a retry as one line, marked retried', () => {
    const line = retriedEvent(testCase('passed', undefined, 's > t', 1));
    expect(JSON.parse(line as string)).toEqual({
      file: 'tests/browser/x.test.ts',
      test: 's > t',
      message: 'passed on retry 1',
      retried: true,
    });
  });

  it('writes nothing for a test that passed first time, or failed after its retry', () => {
    expect(retriedEvent(testCase('passed'))).toBeUndefined();
    // Falsifiable: mark every retried test and a test red twice shows twice.
    expect(
      retriedEvent(testCase('failed', [{ message: 'x' }], 's > t', 1)),
    ).toBeUndefined();
  });
});

describe('notExercisedEvent', () => {
  const annotated = (annotations: { type: string; message: string }[]) => ({
    ...testCase('passed'),
    annotations: () => annotations,
  });

  it('writes a test whose case was not reached as one line, with why', () => {
    const line = notExercisedEvent(
      annotated([
        { type: 'not-exercised', message: 'the verdict was not parked' },
      ]),
    );
    expect(JSON.parse(line as string)).toEqual({
      file: 'tests/browser/x.test.ts',
      test: 's > t',
      message: 'not exercised: the verdict was not parked',
      notExercised: true,
    });
  });

  it('writes nothing for a test with no such annotation', () => {
    expect(
      notExercisedEvent(annotated([{ type: 'notice', message: 'x' }])),
    ).toBeUndefined();
    expect(notExercisedEvent(testCase('passed'))).toBeUndefined();
  });
});

describe('ProgressReporter', () => {
  const saved = process.env.BSQ_PROGRESS_EVENTS;
  let dir: string | undefined;
  afterEach(() => {
    if (saved === undefined) delete process.env.BSQ_PROGRESS_EVENTS;
    else process.env.BSQ_PROGRESS_EVENTS = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('appends each failed test to the events file it is given', () => {
    dir = mkdtempSync(join(tmpdir(), 'progress-reporter-'));
    const file = join(dir, 'unit.ndjson');
    process.env.BSQ_PROGRESS_EVENTS = file;
    const reporter = new ProgressReporter();
    reporter.onTestCaseResult(
      testCase('failed', [], 'a') as unknown as TestCase,
    );
    reporter.onTestCaseResult(
      testCase('passed', [], 'b') as unknown as TestCase,
    );
    reporter.onTestCaseResult(
      testCase('failed', [], 'c') as unknown as TestCase,
    );
    const tests = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).test);
    expect(tests).toEqual(['a', 'c']);
  });

  it('does nothing without an events file', () => {
    delete process.env.BSQ_PROGRESS_EVENTS;
    expect(() =>
      new ProgressReporter().onTestCaseResult(
        testCase('failed') as unknown as TestCase,
      ),
    ).not.toThrow();
  });
});

describe('ProgressReporter, failures outside a test', () => {
  const saved = process.env.BSQ_PROGRESS_EVENTS;
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'progress-reporter-'));
    file = join(dir, 'cell.ndjson');
    process.env.BSQ_PROGRESS_EVENTS = file;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BSQ_PROGRESS_EVENTS;
    else process.env.BSQ_PROGRESS_EVENTS = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const events = () =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const moduleId = join(ROOT, 'tests/browser/x.test.ts');

  it('reports a file that failed to load, or in a file-level hook', () => {
    // Vitest marks its tests skipped, not failed: no test result says it.
    new ProgressReporter().onTestModuleEnd({
      moduleId,
      errors: () => [{ message: 'Error: import failed\n  at x' }],
    } as unknown as TestModule);
    expect(events()).toEqual([
      {
        file: 'tests/browser/x.test.ts',
        test: '(file)',
        message: 'Error: import failed',
      },
    ]);
  });

  it('reports a suite whose hook failed', () => {
    new ProgressReporter().onTestSuiteResult({
      fullName: 'suite',
      module: { moduleId },
      errors: () => [{ message: 'Error: beforeAll' }],
    } as unknown as TestSuite);
    expect(events()).toEqual([
      {
        file: 'tests/browser/x.test.ts',
        test: 'suite',
        message: 'Error: beforeAll',
      },
    ]);
  });

  it('reports nothing for a file or suite without errors', () => {
    const reporter = new ProgressReporter();
    reporter.onTestModuleEnd({
      moduleId,
      errors: () => [],
    } as unknown as TestModule);
    reporter.onTestSuiteResult({
      fullName: 'suite',
      module: { moduleId },
      errors: () => [],
    } as unknown as TestSuite);
    expect(events()).toEqual([]);
  });
});

describe('failureEvent, a long message', () => {
  it('keeps the first 300 characters of a long first line', () => {
    // Falsifiable: no cap and one 70 KB line fills the whole summary.
    const { message } = JSON.parse(
      failureEvent(
        testCase('failed', [{ message: 'x'.repeat(5000) }]),
      ) as string,
    );
    expect(message).toBe(`${'x'.repeat(299)}…`);
  });
});

describe('failureEvent, a Windows path', () => {
  it('names the file with forward slashes whatever the platform', () => {
    // Falsifiable: keep path.relative's separators and Windows writes tests\browser\….
    const line = failureEvent({
      ...testCase('failed'),
      module: { moduleId: join(ROOT, 'tests\\browser\\x.test.ts') },
    });
    expect(JSON.parse(line as string).file).toBe('tests/browser/x.test.ts');
  });
});

describe('ProgressReporter, what a job is doing when it is cut', () => {
  const saved = process.env.BSQ_PROGRESS_EVENTS;
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'progress-reporter-'));
    file = join(dir, 'cell.ndjson');
    process.env.BSQ_PROGRESS_EVENTS = file;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env.BSQ_PROGRESS_EVENTS;
    else process.env.BSQ_PROGRESS_EVENTS = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  const testModule = (name: string) =>
    ({
      moduleId: join(ROOT, `tests/browser/${name}`),
      errors: () => [],
    }) as unknown as TestModule;
  const at = (seconds: number) => vi.setSystemTime(seconds * 1000);
  const cutAt = (seconds: number) => inFlightReport(file, seconds * 1000);

  it('names the test in flight, and how long it has run', () => {
    const reporter = new ProgressReporter();
    reporter.onTestModuleStart(testModule('x.test.ts'));
    at(5);
    reporter.onTestCaseReady(testCase('pending') as unknown as TestCase);
    expect(cutAt(3600)).toBe(
      'in flight: tests/browser/x.test.ts › s > t, started 3595s before the cut',
    );
  });

  it('names the file in flight between two of its tests, and what ended last', () => {
    // Falsifiable: keep the test after its result and the cut blames a test that ended.
    const reporter = new ProgressReporter();
    reporter.onTestModuleStart(testModule('x.test.ts'));
    reporter.onTestCaseReady(testCase('pending') as unknown as TestCase);
    at(7);
    reporter.onTestCaseResult(testCase('passed') as unknown as TestCase);
    expect(cutAt(3600)).toBe(
      'in flight: tests/browser/x.test.ts, no test running; last ended: tests/browser/x.test.ts › s > t, 3593s before the cut',
    );
  });

  it('says no file runs after one ended and before the next started', () => {
    // Falsifiable: keep the file after its end and the cut blames the file that finished.
    const reporter = new ProgressReporter();
    reporter.onTestModuleStart(testModule('close.test.ts'));
    at(60);
    reporter.onTestModuleEnd(testModule('close.test.ts'));
    expect(cutAt(3600)).toBe(
      'in flight: no file running; last ended: tests/browser/close.test.ts, 3540s before the cut',
    );
  });

  it('names a file that started and has run no test yet', () => {
    const reporter = new ProgressReporter();
    at(2);
    reporter.onTestModuleStart(testModule('x.test.ts'));
    expect(cutAt(3600)).toBe(
      'in flight: tests/browser/x.test.ts, no test started, the file started 3598s before the cut',
    );
  });

  it('says nothing was reported when no file started', () => {
    expect(cutAt(3600)).toBe('in flight: nothing reported, no file started');
  });

  it('leaves the failure events alone', () => {
    // ci-progress reads every .ndjson line as a failure: the state lives apart.
    const reporter = new ProgressReporter();
    reporter.onTestModuleStart(testModule('x.test.ts'));
    reporter.onTestCaseReady(testCase('pending') as unknown as TestCase);
    reporter.onTestCaseResult(testCase('passed') as unknown as TestCase);
    expect(existsSync(file)).toBe(false);
  });
});
