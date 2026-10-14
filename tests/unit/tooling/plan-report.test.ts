import { describe, expect, it } from 'vitest';
import { deadIsFatal } from '../../../scripts/plan-report.ts';

const full = {
  mode: 'all-pairs',
  explicitPairs: false,
  browsers: 2,
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
    expect(deadIsFatal({ ...full, browsers: 1 }, true)).toBe(false);
    expect(deadIsFatal({ ...full, modes: 1 }, true)).toBe(false);
  });
});
