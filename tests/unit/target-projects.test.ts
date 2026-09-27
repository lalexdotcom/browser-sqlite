import { describe, expect, it } from '@rstest/core';
import type { PlatformFeature } from '../../src/const/platform';
import {
  CHROMIUM_FEATURES,
  FIREFOX_FEATURES,
  onUnmetFromEnv,
  targetsFromEnv,
} from '../target-projects';

describe('onUnmetFromEnv', () => {
  // Falsifiable: default to 'skip', or accept any value as one of the two.
  it('falls back unless told to skip, and refuses anything else', () => {
    expect(onUnmetFromEnv(undefined)).toBe('fallback');
    expect(onUnmetFromEnv('fallback')).toBe('fallback');
    expect(onUnmetFromEnv('skip')).toBe('skip');
    expect(() => onUnmetFromEnv('skipped')).toThrow(/BSQ_TEST_NEEDS/);
  });
});

describe('targetsFromEnv', () => {
  // Falsifiable: resolve the default targets without the engine's features.
  it('runs each recommended VFS on the default build of the engine under test', () => {
    for (const engine of [CHROMIUM_FEATURES, FIREFOX_FEATURES]) {
      expect(targetsFromEnv(undefined, engine)).toEqual([
        { vfs: 'OPFSWriteAheadVFS', build: 'sync' },
        { vfs: 'OPFSAdaptiveVFS', build: 'jspi' },
      ]);
    }
  });

  it('falls back to async on an engine without JSPI', () => {
    expect(
      targetsFromEnv(undefined, new Set<PlatformFeature>()),
    ).toContainEqual({
      vfs: 'OPFSAdaptiveVFS',
      build: 'async',
    });
  });
});
