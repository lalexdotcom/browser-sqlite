import { describe, expect, it } from '@rstest/core';
import { parseMatrixReport, runBounded } from '../../scripts/test-matrix.mjs';

/**
 * Fixtures are trimmed excerpts of real rstest 0.11.8 markdown reports,
 * captured 2026-09-15 by running `BSQ_TEST_TARGETS=OPFSAdaptiveVFS/async
 * pnpm exec rstest --project 'chromium*' run` (passing case) and a synthetic
 * failing `unit` project run (failing / not-runnable cases). Only the parts
 * `parseMatrixReport` actually reads are kept.
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

describe('parseMatrixReport', () => {
  it('reads a passing summary', () => {
    expect(parseMatrixReport(PASSING_REPORT)).toEqual({
      status: 'passed',
      tests: 526,
      passed: 522,
      failed: 0,
      skipped: 4,
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
