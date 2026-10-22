import type { BrowserName } from './browser-names.ts';

/**
 * Whether a dead test (eligible on no pair of any selected browser) fails the
 * run (spec 2026-10-12 § 4). Only a run that saw every pair of Chrome and
 * Firefox (the default browsers; Safari, opt-in, may come in addition) in both
 * modes can call a test dead; locally a browser may simply be absent, so a
 * complement run fails on it only in CI, where both are installed.
 */
export const deadIsFatal = (
  run: {
    mode: 'complement' | 'all-pairs';
    explicitPairs: boolean;
    browsers: readonly BrowserName[];
    modes: number;
  },
  ci: boolean,
): boolean =>
  !run.explicitPairs &&
  // Chrome and Firefox are the default browsers; Safari, opt-in, adds to them.
  run.browsers.includes('chrome') &&
  run.browsers.includes('firefox') &&
  run.modes === 2 &&
  (run.mode === 'all-pairs' || ci);
