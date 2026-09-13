import { describe, expect, it } from '@rstest/core';
import { firstMissing, WORKER_PROBES } from '../../src/worker/probes';

/** Chromium 121+: the handle carries the `mode` attribute. */
class HandleWithMode {
  get mode() {
    return 'readwrite-unsafe';
  }
}
/** Firefox and Safari: the interface exists, the attribute does not. */
class HandleWithoutMode {}

describe('worker probes — readwrite-unsafe', () => {
  // Falsifiable: make the probe return true unconditionally — the Firefox and
  // Safari shape then reports the feature present.
  it('is missing where the handle has no mode attribute (Firefox, Safari)', () => {
    expect(
      firstMissing(['readwrite-unsafe'], {
        FileSystemSyncAccessHandle: HandleWithoutMode,
      }),
    ).toBe('readwrite-unsafe');
  });

  // Falsifiable: make the probe return false unconditionally — the Chromium
  // shape then reports the feature missing.
  it('is present where the handle carries mode (Chromium 121+)', () => {
    expect(
      firstMissing(['readwrite-unsafe'], {
        FileSystemSyncAccessHandle: HandleWithMode,
      }),
    ).toBeNull();
  });

  // Falsifiable: drop the `typeof … === 'function'` check — reading
  // `.prototype` of undefined throws instead of answering.
  it('is missing where the interface does not exist at all (the page)', () => {
    expect(firstMissing(['readwrite-unsafe'], {})).toBe('readwrite-unsafe');
  });
});

describe('worker probes — firstMissing', () => {
  // Falsifiable: treat a feature with no worker probe as missing — a
  // declaration naming one would then decline every surplus worker everywhere.
  it('never reports a feature it cannot probe', () => {
    expect(firstMissing(['opfs'], {})).toBeNull();
  });

  it('reports nothing for an empty list', () => {
    expect(firstMissing([], {})).toBeNull();
  });

  it('probes readwrite-unsafe and nothing else today', () => {
    expect(Object.keys(WORKER_PROBES)).toEqual(['readwrite-unsafe']);
  });
});
