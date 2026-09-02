import { describe, expect, it, onTestFinished } from '@rstest/core';
import { heldNamesIn, holdIn, makeRealm } from './helpers/realm';

const KEY_NAME = 'browser-sqlite.epochs.v1';

describe('a same-origin iframe as a second realm', () => {
  // If this ever goes red, `multi-client.test.ts`'s "two clients contend
  // exactly as two tabs would" would start being true of the epoch too, and
  // the cross-tab tests would be measuring nothing.
  it('does not share the epoch registry with the parent', async () => {
    const realm = await makeRealm();
    const parentSymbol = Symbol.for(KEY_NAME);
    const realmSymbol = (
      realm as unknown as { Symbol: typeof Symbol }
    ).Symbol.for(KEY_NAME);

    // Measured 2026-08-31 on both engines: the global SYMBOL registry IS
    // shared across realms. The separation comes from `globalThis`, which is
    // where `epochs.ts` puts its Map — not from the symbol.
    expect(realmSymbol).toBe(parentSymbol);

    (globalThis as unknown as Record<symbol, unknown>)[parentSymbol] = new Map([
      ['probe.db', { value: 42 }],
    ]);
    onTestFinished(() => {
      delete (globalThis as unknown as Record<symbol, unknown>)[parentSymbol];
    });
    expect(
      (realm as unknown as Record<symbol, unknown>)[realmSymbol],
    ).toBeUndefined();
  });

  it('shares Web Locks with the parent, both directions', async () => {
    const realm = await makeRealm();

    const fromRealm = await holdIn(realm, 'bsq:test:from-realm');
    expect(await heldNamesIn(window)).toContain('bsq:test:from-realm');
    fromRealm();

    const fromParent = await holdIn(window, 'bsq:test:from-parent');
    expect(await heldNamesIn(realm)).toContain('bsq:test:from-parent');
    fromParent();
  });

  it('contends with the parent for an exclusive name', async () => {
    const realm = await makeRealm();
    const held = await holdIn(window, 'bsq:test:contended');

    let granted = false;
    const contender = holdIn(realm, 'bsq:test:contended').then((release) => {
      granted = true;
      release();
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(granted).toBe(false);

    held();
    await contender;
    expect(granted).toBe(true);
  });

  it('does not contend for a shared name — what the epoch marker relies on', async () => {
    const realm = await makeRealm();
    const inParent = await holdIn(window, 'bsq:test:shared', 'shared');
    const inRealm = await holdIn(realm, 'bsq:test:shared', 'shared');
    expect(await heldNamesIn(window)).toContain('bsq:test:shared');
    inRealm();
    inParent();
  });
});
