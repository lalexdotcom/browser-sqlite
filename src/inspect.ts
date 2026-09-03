import { SQLiteError } from './errors';
import type { LockEntries, Locks } from './locks';
import {
  createLocks,
  parseClientMarker,
  sharesStorage,
  writeLockName,
} from './locks';
import type { SQLiteVFS } from './types';
import { RECOMMENDED_VFS, VFS_CAPABILITIES } from './types';
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

export type ClientInspection = InspectionBase & {
  /**
   * This client, or `null` when this client's own marker is not in the
   * snapshot — the brief window before its Web Locks grant has landed, or when
   * the grant could not be taken at all.
   */
  readonly self: DatabaseClient | null;
  readonly siblings: readonly DatabaseClient[];
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
  if (!sharesStorage(vfs)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} keeps its pages in the worker that opened them, so two clients are two databases and there is nothing to inspect. Ask this of a persistent VFS.`,
    );
  }
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
 * Whether any OTHER client of this library holds `file` on `vfs`.
 *
 * The discriminator behind the `openTimeout` message: a slot that never became
 * ready is usually blamed on another tab, and that is often false — a page
 * reloaded without `close()` leaves a dead context holding the database, and
 * no live client to find. One `entries()` call tells the two apart.
 *
 * Deliberately NOT `inspectWith`: this runs while the pool is half-open, so it
 * resolves no realm id (which would take a lock), touches nothing the client
 * owns, and never throws. `undefined` is "could not be answered" — Web Locks
 * missing, a VFS whose pages never leave their worker, a registry that rejects,
 * or one that does not answer within `deadlineMs`. A caller that reads
 * `undefined` as `false` would state the opposite of what was observed.
 *
 * `false` means no client of THIS library holds it — never that nobody does.
 * Another library, another origin's tooling and native code are all invisible
 * to the Web Locks registry.
 */
export const libraryClientsHold = async (
  locks: Locks,
  file: string,
  vfs: SQLiteVFS,
  ownId: string,
  deadlineMs = 250,
): Promise<boolean | undefined> => {
  if (!locks.available || !sharesStorage(vfs)) return undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      locks.entries(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, deadlineMs, undefined);
      }),
    ]);
    if (!snapshot) return undefined;

    return snapshot.held.some((entry) => {
      const marker = parseClientMarker(entry.name, vfs, file);
      return marker !== undefined && marker.id !== ownId;
    });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

export type InspectDatabaseOptions = {
  /**
   * The VFS the database was created with. Required, and not defaulted: four
   * VFS share one underlying file, and the others are separate stores
   * entirely, so guessing would report on a different database.
   */
  vfs: SQLiteVFS;
};

/**
 * Who is live on a database, without opening it.
 *
 * This is a snapshot, stale the instant it resolves. It informs a UI; it never
 * authorizes an action — `deleteDatabase` raising `DATABASE_IN_USE` is the only
 * authority on whether a database can be removed.
 *
 * Takes `file` positionally like `createSQLiteClient` and `deleteDatabase`:
 * every root export of this library names the database the same way.
 *
 * @throws {SQLiteError} `INVALID_OPTION` when `vfs` is missing, unknown, or a
 *   memory VFS, where two clients are two databases and the question has no
 *   meaning.
 * @throws {SQLiteError} `UNSUPPORTED` where the Web Locks API is unavailable.
 *   Reporting zero there would be indistinguishable from a database nobody
 *   holds.
 */
export const inspectDatabase = async (
  file: string,
  options: InspectDatabaseOptions,
): Promise<DatabaseInspection> => {
  if (!options?.vfs) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `vfs is required. Pass the VFS the database was created with — ${RECOMMENDED_VFS} is the recommended universal choice. Four VFS share one underlying file, and the rest are separate stores, so the wrong one reports on a different database.`,
    );
  }

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

  return inspectWith(locks, normalizeDatabaseFile(file), vfs);
};
