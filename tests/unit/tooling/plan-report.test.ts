import { describe, expect, it } from 'vitest';
import { deadIsFatal } from '../../../scripts/plan-report.ts';

const full = {
  mode: 'all-pairs',
  explicitPairs: false,
  browsers: ['chrome', 'firefox'],
  modes: 2,
} as const;

describe('deadIsFatal', () => {
  it('fails a full all-pairs run, locally or in CI', () => {
    expect(deadIsFatal(full, false)).toBe(true);
  });

  it('fails a full complement run in CI only, where both browsers are certain', () => {
    // Falsifiable: drop the CI case and verify never sees a dead test (spec § 4).
    const complement = { ...full, mode: 'complement' } as const;
    expect(deadIsFatal(complement, true)).toBe(true);
    expect(deadIsFatal(complement, false)).toBe(false);
  });

  it('never fails a run narrowed to some pairs, browsers or modes', () => {
    expect(deadIsFatal({ ...full, explicitPairs: true }, true)).toBe(false);
    expect(deadIsFatal({ ...full, browsers: ['chrome'] }, true)).toBe(false);
    expect(deadIsFatal({ ...full, modes: 1 }, true)).toBe(false);
  });

  // Falsifiable: count the browsers and a macOS run with Safari added stops
  // calling a dead test fatal (2026-10-22 spec, § Decided).
  it('stays fatal on a full run that adds Safari', () => {
    expect(
      deadIsFatal(
        { ...full, browsers: ['chrome', 'firefox', 'safari'] },
        false,
      ),
    ).toBe(true);
  });

  it('is not fatal on Safari alone', () => {
    expect(
      deadIsFatal({ ...full, mode: 'complement', browsers: ['safari'] }, true),
    ).toBe(false);
  });
});
