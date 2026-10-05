import { describe, expect, it } from '@rstest/core';
import { detectFeatures, missingFeature } from '../../src/capabilities';
import { BUILD_CAPABILITIES } from '../../src/const/builds';
import { VFS_CAPABILITIES } from '../../src/const/vfs';
import { AVAILABLE_FEATURES } from '../conformance/helpers';
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
    // `AVAILABLE_FEATURES` is `found` plus what only a worker can probe —
    // `sync-access-handle` among the requirements — so a page probe that
    // misses its feature still fails here.
    const required = [
      ...VFS_CAPABILITIES[TEST_TARGET.vfs].requires,
      ...BUILD_CAPABILITIES[TEST_TARGET.build].requires,
    ];

    for (const feature of required) {
      expect(`${feature}: ${AVAILABLE_FEATURES.has(feature)}`).toBe(
        `${feature}: true`,
      );
    }
    expect(
      missingFeature(TEST_TARGET.vfs, TEST_TARGET.build, found),
    ).toBeNull();
  });

  it('never reports what no page can probe', () => {
    // A worker answers these (src/worker/probes.ts, the conformance probe): sync
    // access handles exist in dedicated workers only, and from the page WebIDL
    // drops the unknown `mode` member without complaining, so a page probe of
    // `readwrite-unsafe` would always say yes.
    expect(detectFeatures().has('sync-access-handle')).toBe(false);
    expect(detectFeatures().has('readwrite-unsafe')).toBe(false);
  });
});
