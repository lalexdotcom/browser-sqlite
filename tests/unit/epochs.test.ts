import { describe, expect, it } from '@rstest/core';
import { advanceSeen, epochsFor } from '../../src/epochs';

describe('epochsFor', () => {
  it('starts at zero and only goes up', () => {
    const e = epochsFor('/counts-up');
    expect(e.current()).toBe(0);
    expect(e.bump()).toBe(1);
    expect(e.bump()).toBe(2);
    expect(e.current()).toBe(2);
  });

  it('shares one counter between handles on the same database', () => {
    const a = epochsFor('/shared');
    const b = epochsFor('/shared');
    a.bump();
    expect(b.current()).toBe(1);
  });

  it('keeps distinct databases apart', () => {
    const a = epochsFor('/apart-a');
    const b = epochsFor('/apart-b');
    a.bump();
    expect(b.current()).toBe(0);
  });

  // Falsifiable: replace the globalThis symbol lookup with a module-level
  // `const registry = new Map()` and this goes red. That is the whole point of
  // the symbol: a bundler that loads two copies of this module (Vite
  // pre-bundling, two versions in a pnpm workspace, a dual ESM/CJS
  // resolution) must still find one counter, or two clients in one tab stop
  // seeing each other with no visible symptom.
  it('adopts a registry another module copy already installed', async () => {
    const key = Symbol.for('browser-sqlite.epochs.v1');
    const host = globalThis as unknown as Record<symbol, unknown>;
    host[key] = new Map([['/preseeded', { value: 41 }]]);

    // In rstest's bundled Node environment the query-string trick does not
    // produce a separate module instance. A plain re-import is equivalent
    // because registry() reads globalThis[REGISTRY_KEY] on every call —
    // it never caches at module level — so seeding globalThis before the
    // call proves adoption regardless of whether `fresh` is a new copy.
    const fresh = await import('../../src/epochs');
    expect(fresh.epochsFor('/preseeded').current()).toBe(41);
  });
});

describe('advanceSeen', () => {
  // Falsifiable: return `next` unconditionally and the second case goes red.
  // That case is the only place in the design where an error yields stale data
  // instead of a wasted prelude.
  it('advances when our commit is the next epoch', () => {
    expect(advanceSeen(5, 5, 6)).toBe(6);
  });

  it('does not advance when another client committed during our lease', () => {
    expect(advanceSeen(5, 5, 7)).toBe(5);
  });

  it('does not advance a worker that never caught up', () => {
    expect(advanceSeen(-1, 3, 4)).toBe(-1);
  });
});
