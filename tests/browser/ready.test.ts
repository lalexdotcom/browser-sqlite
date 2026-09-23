import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

describe('db.ready', () => {
  // Falsifiable: drop `readyDeferred.resolve()` from onGateOpen — `ready`
  // never settles and the test times out. `toBeInstanceOf(Promise)` keeps a
  // missing property from passing, since `await undefined` resolves too.
  it('resolves once the pool has started', async () => {
    const db = await createTestClient();
    expect(db.ready).toBeInstanceOf(Promise);
    await db.ready;
    expect(db.poolSize).toBeGreaterThan(0);
  });

  // Falsifiable: drop `readyDeferred.reject(closingError)` from close() —
  // shutdown rejects the gate, onGateOpen never runs, and `ready` stays
  // pending until the test times out.
  it('rejects with CLIENT_CLOSED when close() comes before the pool has started', async () => {
    const db = await createTestClient();
    const closed = db.close();
    await expect(db.ready).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    await closed;
  });
});
