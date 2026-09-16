import { describe, expect, it } from '@rstest/core';
import { detectFeatures, missingFeature } from '../../src/capabilities';
import { BUILD_REQUIREMENTS, VFS_CAPABILITIES } from '../../src/types';
import { TEST_TARGET } from './helpers';

/**
 * `detectFeatures` decides what a browser can do, and every other test trusts
 * it: the client refuses a pair whose features are missing, and the matrix
 * reports TARGET_NOT_RUNNABLE from the same answer. Until 2026-09-16 it was
 * asserted in Node only — where no global it probes exists, so every probe
 * answers false and the positive branch was never taken anywhere.
 *
 * The running target is the evidence. This project loaded its VFS and its
 * build, so whatever that pair requires IS here, and a probe that says
 * otherwise is wrong.
 */
describe('detectFeatures, in the engine', () => {
  it('finds every feature the running pair requires', () => {
    const found = detectFeatures();
    // No VFS lists `readwrite-unsafe` in `requires` — it decides exclusivity,
    // not whether a VFS loads — so every feature here has a page probe.
    const required = [
      ...VFS_CAPABILITIES[TEST_TARGET.vfs].requires,
      ...BUILD_REQUIREMENTS[TEST_TARGET.build],
    ];

    for (const feature of required) {
      expect(`${feature}: ${found.has(feature)}`).toBe(`${feature}: true`);
    }
    expect(
      missingFeature(TEST_TARGET.vfs, TEST_TARGET.build, found),
    ).toBeNull();
  });

  it('never reports readwrite-unsafe, which no page can probe', () => {
    // A worker answers that one (src/worker/probes.ts), and the second-client
    // guard is built on its answer. From the page, WebIDL drops the unknown
    // `mode` member without complaining, so a page probe would always say yes.
    expect(detectFeatures().has('readwrite-unsafe')).toBe(false);
  });
});
