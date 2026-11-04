/**
 * A Vitest reporter that appends each failed test, as it fails, to the events
 * file of its job (`BSQ_PROGRESS_EVENTS`), one JSON line per test.
 *
 * The planners (scripts/test-plan.ts, scripts/test-parallel.ts) add it to every
 * process they start and read those files back, so that a CI check run shows
 * a failure before its cell ends (scripts/ci-progress.ts). Without the
 * variable it does nothing. A test that passed on a retry (`timeoutRetry`,
 * scripts/processes.ts) is reported once, as retried, never as failed.
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node';
import { ROOT } from './parallel.ts';

type Reported = {
  fullName: string;
  module: { moduleId: string };
  result(): {
    state: string;
    errors?: readonly { message?: string | undefined }[] | undefined;
  };
  diagnostic?(): { retryCount: number; flaky: boolean } | undefined;
};

/** The events line of a failed test; undefined for any other result. */
export function failureEvent(testCase: Reported): string | undefined {
  const result = testCase.result();
  if (result.state !== 'failed') return undefined;
  return errorEvent(testCase.module.moduleId, testCase.fullName, result.errors);
}

/** The events line of a test that passed on a retry; undefined otherwise. */
export function retriedEvent(testCase: Reported): string | undefined {
  const diagnostic = testCase.diagnostic?.();
  if (!diagnostic?.flaky) return undefined;
  return eventLine(
    testCase.module.moduleId,
    testCase.fullName,
    `passed on retry ${diagnostic.retryCount}`,
    true,
  );
}

/** A first line long enough to read, short enough that one cannot fill the summary. */
const MESSAGE_MAX = 300;

function errorEvent(
  moduleId: string,
  test: string,
  errors: readonly { message?: string | undefined }[] | undefined,
): string {
  const first = (errors?.[0]?.message ?? '').split('\n')[0] as string;
  const message =
    first.length > MESSAGE_MAX ? `${first.slice(0, MESSAGE_MAX - 1)}…` : first;
  return eventLine(moduleId, test, message, false);
}

function eventLine(
  moduleId: string,
  test: string,
  message: string,
  retried: boolean,
): string {
  // Forward slashes on every platform: path.relative writes `\` on Windows.
  const file = relative(ROOT, moduleId).replace(/\\/g, '/');
  const event = retried
    ? { file, test, message, retried }
    : { file, test, message };
  return `${JSON.stringify(event)}\n`;
}

export default class ProgressReporter implements Reporter {
  onTestCaseResult(testCase: TestCase) {
    const line = failureEvent(testCase) ?? retriedEvent(testCase);
    if (line) append(line);
  }

  // A file that fails to load, or in a hook, marks its tests skipped, not
  // failed: only the file or the suite carries the error.
  onTestModuleEnd(testModule: TestModule) {
    const errors = testModule.errors();
    if (errors.length > 0) {
      append(errorEvent(testModule.moduleId, '(file)', errors));
    }
  }

  onTestSuiteResult(testSuite: TestSuite) {
    const errors = testSuite.errors();
    if (errors.length > 0) {
      append(errorEvent(testSuite.module.moduleId, testSuite.fullName, errors));
    }
  }
}

function append(line: string) {
  const file = process.env.BSQ_PROGRESS_EVENTS;
  if (file) appendFileSync(file, line);
}
