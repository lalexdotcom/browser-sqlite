import { TestRunner } from 'vitest';

/**
 * Whether the case under test was reached. On a slow runner a precondition can
 * miss with nothing wrong in the library — the verdict not yet parked, the
 * callback not yet entered. Asserting it turned such runs red; ignoring it
 * left a pass that proved nothing (user, 2026-11-05). So a miss is annotated
 * `not-exercised` and the caller returns early, after its own cleanup:
 *
 *     if (!(await exercised(parked, 'the verdict was not parked'))) return;
 *
 * The merged report and the progress check run list it apart
 * (scripts/skip-notes.ts, scripts/progress-reporter.ts). Not `ctx.skip()`:
 * that cancels the test's `onTestFinished` cleanups, which the helpers use to
 * close clients and delete databases.
 */
export const exercised = async (
  reached: boolean,
  missed: string,
  annotate: (message: string, type: string) => Promise<unknown> = annotateTest,
): Promise<boolean> => {
  if (reached) return true;
  await annotate(missed, 'not-exercised');
  return false;
};

/** The current test's annotation; a miss outside a test throws instead. */
const annotateTest = (message: string, type: string) => {
  const context = TestRunner.getCurrentTest()?.context;
  if (context === undefined) {
    throw new Error(`case not exercised, outside a test: ${message}`);
  }
  return context.annotate(message, type);
};
