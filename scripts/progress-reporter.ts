/**
 * A Vitest reporter that appends each failed test, as it fails, to the events
 * file of its job (`BSQ_PROGRESS_EVENTS`), one JSON line per test.
 *
 * The planners (scripts/test-plan.ts, scripts/test-parallel.ts) add it to every
 * process they start and read those files back, so that a CI check run shows
 * a failure before its cell ends (scripts/ci-progress.ts). Without the
 * variable it does nothing. A test retried to a pass is reported once, by its
 * final result, which passed.
 */
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';
import { ROOT } from './parallel.ts';

type Reported = {
  fullName: string;
  module: { moduleId: string };
  result(): {
    state: string;
    errors?: readonly { message?: string | undefined }[] | undefined;
  };
};

/** The events line of a failed test; undefined for any other result. */
export function failureEvent(testCase: Reported): string | undefined {
  const result = testCase.result();
  if (result.state !== 'failed') return undefined;
  const message = result.errors?.[0]?.message ?? '';
  return `${JSON.stringify({
    file: relative(ROOT, testCase.module.moduleId),
    test: testCase.fullName,
    message: message.split('\n')[0],
  })}\n`;
}

export default class ProgressReporter implements Reporter {
  onTestCaseResult(testCase: TestCase) {
    const file = process.env.BSQ_PROGRESS_EVENTS;
    if (!file) return;
    const line = failureEvent(testCase);
    if (line) appendFileSync(file, line);
  }
}
