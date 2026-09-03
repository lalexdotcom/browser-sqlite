import { SQLiteError } from './errors';
import type { LockEntries, Locks } from './locks';
import {
  createLocks,
  parseClientMarker,
  sharesStorage,
  writeLockName,
} from './locks';
import type { SQLiteVFS } from './types';
import { VFS_CAPABILITIES } from './types';
import { normalizeDatabaseFile } from './utils';

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

/** One live client on a database. */
export type DatabaseClient = {
  readonly id: string;
  readonly name: string;
  /** The realm holding it. Every client in one tab reports the same value. */
  readonly tab: string;
  /** That realm is the caller's. A same-origin iframe is another tab here. */
  readonly sameTab: boolean;
  /** Four VFS share the `opfs` namespace, and therefore the file. */
  readonly vfs: SQLiteVFS;
};

export type InspectionBase = {
  readonly file: string;
  readonly vfs: SQLiteVFS;
  /** Distinct realms among the clients. */
  readonly tabs: number;
  readonly write: {
    /** The realm writing now, never the client. `null` when nobody writes. */
    readonly tab: string | null;
    /** Always false when `tab` is null. */
    readonly sameTab: boolean;
    /** Writers queued behind it, across the whole origin. */
    readonly waiting: number;
  };
};

export type DatabaseInspection = InspectionBase & {
  readonly clients: readonly DatabaseClient[];
};

/**
 * The census, given locks that are already known to work.
 *
 * One `entries()` call supplies the roster, the writer and the queue together,
 * so those three always describe the same instant and cannot compose a state
 * that never existed. The one exception: a realm whose id has never been
 * resolved and that was given no marker pays one extra query to read its own
 * `clientId` back — once, and never again for that realm's lifetime.
 */
export const inspectWith = async (
  locks: Locks,
  file: string,
  vfs: SQLiteVFS,
  ownMarkerName?: string,
): Promise<DatabaseInspection> => {
  const snapshot = await locks.entries();
  const realm = await resolveRealmId(locks, snapshot, ownMarkerName);

  const clients: DatabaseClient[] = [];
  for (const entry of snapshot.held) {
    const marker = parseClientMarker(entry.name, vfs, file);
    if (!marker) continue;
    clients.push({
      id: marker.id,
      name: marker.name,
      tab: entry.clientId,
      sameTab: entry.clientId === realm,
      vfs: marker.vfs,
    });
  }

  const writeName = writeLockName(vfs, file);
  const writer = snapshot.held.find((entry) => entry.name === writeName);
  const waiting = snapshot.pending.filter(
    (entry) => entry.name === writeName,
  ).length;

  return {
    file,
    vfs,
    clients,
    tabs: new Set(clients.map((client) => client.tab)).size,
    write: {
      tab: writer?.clientId ?? null,
      sameTab: writer !== undefined && writer.clientId === realm,
      waiting,
    },
  };
};

/**
 * Who is live on a database, without opening it.
 *
 * This is a snapshot, stale the instant it resolves. It informs a UI; it never
 * authorizes an action — `deleteDatabase` raising `DATABASE_IN_USE` is the only
 * authority on whether a database can be removed.
 */
export const inspectDatabase = async (options: {
  file: string;
  vfs: SQLiteVFS;
}): Promise<DatabaseInspection> => {
  const { vfs } = options;
  if (!Object.hasOwn(VFS_CAPABILITIES, vfs)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `Unknown vfs '${String(vfs)}'. Supported: ${Object.keys(VFS_CAPABILITIES).join(', ')}.`,
    );
  }
  if (!sharesStorage(vfs)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} keeps its pages in the worker that opened them, so two clients are two databases and there is nothing to inspect. Ask this of a persistent VFS.`,
    );
  }

  const locks = createLocks();
  if (!locks.available) {
    throw new SQLiteError(
      'UNSUPPORTED',
      'The Web Locks API is unavailable, so clients on a database cannot be counted. Reporting zero would be indistinguishable from a database nobody holds.',
    );
  }

  return inspectWith(locks, normalizeDatabaseFile(options.file), vfs);
};
