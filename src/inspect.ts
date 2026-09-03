import { SQLiteError } from './errors';
import type { LockEntries, Locks } from './locks';

/**
 * The Web Locks `clientId` of THIS realm.
 *
 * There is no API that returns it, so it is read back out of the registry: hold
 * a name nobody else can have, then find that name's entry. A realm's id is
 * stable for its whole life, so this is paid once, ever — and not even once
 * when a marker of ours is already in the snapshot.
 *
 * Module scope is exactly the right scope: an iframe has its own module
 * instance and its own id, which is what makes `sameTab` mean anything.
 */
let cachedRealmId: string | undefined;

export const resolveRealmId = async (
  locks: Locks,
  snapshot: LockEntries,
  ownMarkerName?: string,
): Promise<string> => {
  if (cachedRealmId !== undefined) return cachedRealmId;

  if (ownMarkerName !== undefined) {
    const mine = snapshot.held.find((entry) => entry.name === ownMarkerName);
    if (mine) {
      cachedRealmId = mine.clientId;
      return cachedRealmId;
    }
  }

  const nonce = `bsq:realm:${crypto.randomUUID()}`;
  const release = await locks.hold(nonce, { mode: 'shared' });
  try {
    const fresh = await locks.entries();
    const mine = fresh.held.find((entry) => entry.name === nonce);
    if (!mine) {
      // A registry that does not report a lock we are holding cannot answer
      // `sameTab` either. Saying so beats reporting every client as elsewhere.
      throw new SQLiteError(
        'UNSUPPORTED',
        'This browser does not report lock holders, so clients cannot be located.',
      );
    }
    cachedRealmId = mine.clientId;
    return cachedRealmId;
  } finally {
    release();
  }
};
