/**
 * Whether a dead test (eligible on no pair of any selected browser) fails the
 * run (spec 2026-10-12 § 4). Only a run that saw every pair of both browsers
 * in both modes can call a test dead; locally a browser may simply be absent,
 * so a complement run fails on it only in CI, where both browsers are
 * installed and `verify` runs it.
 */
export const deadIsFatal = (
  run: {
    mode: 'complement' | 'all-pairs';
    explicitPairs: boolean;
    browsers: number;
    modes: number;
  },
  ci: boolean,
): boolean =>
  !run.explicitPairs &&
  run.browsers === 2 &&
  run.modes === 2 &&
  (run.mode === 'all-pairs' || ci);
