import { describe, expect, it } from '@rstest/core';
import {
  formatCell,
  parseMatrixReport,
  runBounded,
} from '../../scripts/test-matrix.ts';

/**
 * Fixtures are trimmed excerpts of real rstest 0.11.8 markdown reports,
 * captured 2026-09-15 by running `BSQ_TEST_TARGETS=OPFSAdaptiveVFS/async
 * pnpm exec rstest --project 'chromium*' run` (passing case) and a synthetic
 * failing `unit` project run (failing / not-runnable cases); the crashed case
 * is the 2026-09-26 matrix's Firefox IDBMirrorVFS/async report. Only the
 * parts `parseMatrixReport` actually reads are kept.
 */

const PASSING_REPORT = `---
tool: "@rstest/core@0.11.8"
timestamp: "2026-09-15T21:17:58.581Z"
runtime: {"node":"v24.13.0","platform":"linux","cwd":"/workspaces/wsqlite"}
---

# Rstest Test Execution Report

## Summary

\`\`\`json
{
  "status": "pass",
  "counts": {
    "testFiles": 48,
    "failedFiles": 0,
    "tests": 526,
    "failedTests": 0,
    "passedTests": 522,
    "skippedTests": 4,
    "todoTests": 0
  },
  "durationMs": {
    "total": 51776,
    "build": 296,
    "tests": 51480
  }
}
\`\`\`

## Failures

No test failures reported.
`;

const FAILING_REPORT = `---
tool: "@rstest/core@0.11.8"
---

# Rstest Test Execution Report

## Summary

\`\`\`json
{
  "status": "fail",
  "counts": {
    "testFiles": 1,
    "failedFiles": 1,
    "tests": 2,
    "failedTests": 2,
    "passedTests": 0,
    "skippedTests": 0,
    "todoTests": 0
  },
  "durationMs": {
    "total": 71,
    "build": 19,
    "tests": 52
  }
}
\`\`\`

## Failures

### [F01] tests/browser/foo.test.ts :: foo > bar

details:

\`\`\`json
{
  "testPath": "tests/browser/foo.test.ts",
  "status": "fail",
  "errors": [
    {
      "type": "Error",
      "message": "expected 1 to be 2"
    }
  ]
}
\`\`\`

### [F02] tests/browser/foo.test.ts :: foo > baz

details:

\`\`\`json
{
  "testPath": "tests/browser/foo.test.ts",
  "status": "fail",
  "errors": [
    {
      "type": "Error",
      "message": "TARGET_NOT_RUNNABLE: no opfs here"
    }
  ]
}
\`\`\`
`;

const NOT_RUNNABLE_REPORT = `---
tool: "@rstest/core@0.11.8"
---

# Rstest Test Execution Report

## Summary

\`\`\`json
{
  "status": "fail",
  "counts": {
    "testFiles": 1,
    "failedFiles": 1,
    "tests": 2,
    "failedTests": 2,
    "passedTests": 0,
    "skippedTests": 0,
    "todoTests": 0
  },
  "durationMs": {
    "total": 71,
    "build": 19,
    "tests": 52
  }
}
\`\`\`

## Failures

### [F01] tests/browser/foo.test.ts :: foo > bar

details:

\`\`\`json
{
  "testPath": "tests/browser/foo.test.ts",
  "status": "fail",
  "errors": [
    {
      "type": "Error",
      "message": "TARGET_NOT_RUNNABLE: readwrite-unsafe is missing here"
    }
  ]
}
\`\`\`

### [F02] tests/browser/foo.test.ts :: foo > baz

details:

\`\`\`json
{
  "testPath": "tests/browser/foo.test.ts",
  "status": "fail",
  "errors": [
    {
      "type": "Error",
      "message": "TARGET_NOT_RUNNABLE: no opfs here"
    }
  ]
}
\`\`\`
`;

const NO_SUMMARY_REPORT = `start   build started...
ready   built in 0.26s

(browser process killed before it could print a report)
`;

const CRASHED_REPORT = `---
tool: "@rstest/core@0.11.8"
timestamp: "2026-09-26T20:18:23.753Z"
runtime: {"node":"v24.13.0","platform":"linux","cwd":"/workspaces/wsqlite"}
---

# Rstest Test Execution Report

## Summary

\`\`\`json
{
  "status": "fail",
  "counts": {
    "testFiles": 38,
    "failedFiles": 0,
    "tests": 206,
    "failedTests": 0,
    "passedTests": 204,
    "skippedTests": 2,
    "todoTests": 0
  },
  "durationMs": {
    "total": 19606,
    "build": 19606,
    "tests": 0
  }
}
\`\`\`

## Failures

No test failures reported.

## Unhandled Errors

### Unhandled Error 1

\`\`\`json
{
  "name": "Error",
  "message": "Browser page crashed while running /workspaces/wsqlite/tests/browser/lifecycle.test.ts."
}
\`\`\`
`;

describe('parseMatrixReport', () => {
  it('reads a passing summary', () => {
    expect(parseMatrixReport(PASSING_REPORT)).toEqual({
      status: 'passed',
      tests: 526,
      passed: 522,
      failed: 0,
      skipped: 4,
      files: 48,
      seconds: 52,
    });
  });

  it('reads a failing summary whose failures are not all TARGET_NOT_RUNNABLE', () => {
    // Falsifiable: classifying this as "not-runnable" would hide a real
    // failure (foo > bar) behind the one TARGET_NOT_RUNNABLE failure.
    expect(parseMatrixReport(FAILING_REPORT)).toEqual({
      status: 'failed',
      tests: 2,
      passed: 0,
      failed: 2,
      skipped: 0,
      files: 1,
      seconds: 0,
    });
  });

  it('classifies a summary as not-runnable only when every failure is TARGET_NOT_RUNNABLE', () => {
    expect(parseMatrixReport(NOT_RUNNABLE_REPORT)).toEqual({
      status: 'not-runnable',
      seconds: 0,
    });
  });

  it('classifies an output with no summary block as timed out', () => {
    // A killed run never gets to print its report, so the absence of a
    // ```json summary block is the signal, not a status word.
    expect(parseMatrixReport(NO_SUMMARY_REPORT)).toEqual({
      status: 'timed-out',
    });
  });
  it('keeps the unhandled errors of a failing report whose tests all passed', () => {
    // Firefox IDBMirrorVFS/async, matrix of 2026-09-26: the page crashed, 38 of
    // 57 files ran, and not one test failed.
    expect(parseMatrixReport(CRASHED_REPORT)).toEqual({
      status: 'failed',
      tests: 206,
      passed: 204,
      failed: 0,
      skipped: 2,
      files: 38,
      seconds: 20,
      // Relative to the report's own `cwd`, which differs on a CI runner.
      unhandled: [
        'Browser page crashed while running tests/browser/lifecycle.test.ts.',
      ],
    });
  });
});

describe('formatCell', () => {
  it('prints counts, files and time for a passing cell', () => {
    expect(formatCell(parseMatrixReport(PASSING_REPORT))).toBe(
      '522/0/4 · 48 files · 52s',
    );
  });

  it('says FAIL, and why, for a failed cell with no failed test', () => {
    // Falsifiable: print only the counts and this cell reads 204/0/2, which
    // is how the crash of 2026-09-26 passed for green in the table.
    expect(formatCell(parseMatrixReport(CRASHED_REPORT))).toBe(
      '204/0/2 · 38 files · 20s · FAIL: Browser page crashed while running tests/browser/lifecycle.test.ts.',
    );
  });
});

describe('runBounded', () => {
  it('resolves with error set when the child fails to start', async () => {
    // Falsifiable: runBounded without an 'error' listener on the child never
    // settles for a command that cannot start — removing that listener turns
    // this test into a timeout instead of a pass. Verified by hand: with the
    // listener commented out, this test hits rstest's 10s project timeout
    // instead of resolving.
    const result = await runBounded('bsq-test-matrix-nonexistent-binary', [], {
      env: process.env,
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error?.code).toBe('ENOENT');
  });

  it('kills a child that outlives its timeout', async () => {
    // Falsifiable: removing the SIGKILL call from runBounded's timer lets the
    // 5s child run to completion instead of being cut off — the assertion on
    // elapsed time (and, with it, this test staying well under `sleep 5`'s
    // 5000ms) would fail. Verified by hand: with the kill removed, this test
    // takes roughly 5s instead of ~200ms and its elapsed-time assertion fails.
    const started = Date.now();
    const result = await runBounded('sleep', ['5'], {
      env: process.env,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(4000);
  });
});
