import type { SQLiteBuild } from './builds';
import type { PlatformFeature } from './platform';

/** Where a VFS keeps the database. */
export type VFSStorage = 'opfs' | 'indexeddb' | 'memory';

/** How much of the database a VFS keeps resident in RAM. */
export type VFSMemoryModel = 'page-cache' | 'whole-database';

/** What a VFS can and cannot do. One entry per VFS, and no second table. */
export type VFSCapability = {
  /** Builds this VFS can run on, most preferred first. */
  readonly builds: readonly [SQLiteBuild, ...SQLiteBuild[]];
  /** Largest pool this VFS supports; `null` when unbounded. */
  readonly maxPoolSize: number | null;
  /** Why the cap exists. Required whenever `maxPoolSize` is not null. */
  readonly poolLimitReason: string | null;
  /** Whether several connections may share one database. */
  readonly multiConnection: boolean;
  /** Whether data outlives `close()`. */
  readonly persistent: boolean;
  /**
   * `page-cache`: only SQLite's page cache is resident, bounded by
   * `PRAGMA cache_size`. `whole-database`: the entire database is resident,
   * and `poolSize` multiplies it.
   */
  readonly memoryModel: VFSMemoryModel;
  /** Where the database actually lives. */
  readonly storage: VFSStorage;
  /**
   * The folder this library places the database in, inside the OPFS root —
   * and, by being set, the statement that this VFS addresses its files by
   * path: the database IS the OPFS entry at `.<folder>/<name>` (the leading
   * dot added by the library), beside its `-journal`, `-wal` and
   * `extraFileSuffixes`. Absent on every other VFS: an
   * OPFS VFS without one keeps a pool of files whose names are not the
   * database's (`AccessHandlePoolVFS`), and IndexedDB and memory have no path.
   *
   * `deleteDatabase` reads it to decide whether the database is an OPFS entry
   * it can test and remove by name — the pass that covers the two VFS whose
   * `jDelete` does not delete. A folder missing here is a deletion that
   * reports success over an intact file; conformance invariant 7 catches it.
   */
  readonly folder?: string;
  /**
   * Whether this VFS takes its OPFS access handle in the EXCLUSIVE mode —
   * `createSyncAccessHandle()` with no `mode`, rather than
   * `mode: 'readwrite-unsafe'`.
   *
   * It decides whether an acquisition has to be retried. A terminated context
   * releases its Web Locks at once but keeps its OPFS access handles for up to
   * ~2 s on Chromium (HANDLE-CORPSE, `mem:measurements`), so a VFS taking an
   * exclusive handle can meet a file held by something that answers nothing:
   * no lock to wait on, no owner to ask, only time to wait out. Where
   * `readwrite-unsafe` is used a second handle is granted regardless, and a
   * dead holder blocks nobody.
   *
   * Declared, and the cause checked as well: on a declared VFS the retry reads
   * the `lastError` the VFS keeps — set by `OPFSCoopSyncVFS` on a failed
   * acquisition since wa-sqlite #357 — and retries only a held file. Where the
   * error comes back from the call itself — VFS instantiation —
   * `createVfsInstance` tests it directly and needs no declaration.
   *
   * NOT declared for `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS`, which ask for
   * `readwrite-unsafe` and fall back to an exclusive handle only on an engine
   * that lacks it. That combination is real but out of reach: Firefox releases
   * a dead worker's handle in 1-6 ms (HANDLE-ORPHAN), a window nothing loses.
   */
  readonly exclusiveFileHandle: boolean;
  /**
   * Platform features without which this VFS cannot work at all.
   *
   * `readwrite-unsafe` is the one that bites: WebIDL ignores the unknown
   * dictionary member on engines that do not implement it, so the handle
   * silently opens exclusive, and a second connection then waits or fails
   * depending on the VFS — see `degradesWithout` and `singleConnectionWithout`.
   * Declaring it is what lets the conformance suite probe for it and skip,
   * instead of leaving it to surface as a 60-second timeout.
   */
  readonly requires: readonly PlatformFeature[];
  /**
   * Platform features this VFS uses when present and works without, at a cost.
   *
   * `OPFSAdaptiveVFS` is the case this field exists for. Without
   * `readwrite-unsafe` it rotates a single exclusive access handle between
   * connections instead of holding one each. That works — Firefox is the engine
   * the browser suite exercises it on — but a connection in a long
   * uninterruptible statement holds the handle, and every other connection to
   * the database, in another client or tab, waits for it. Within one client it
   * runs a single worker there: see `singleConnectionWithout`.
   *
   * Without this distinction, a support table derived from browser specs would
   * mark that VFS broken everywhere outside Chromium, when it merely degrades.
   */
  readonly degradesWithout: readonly PlatformFeature[];
  /**
   * Platform features without which a pool of more than one worker buys this
   * VFS nothing, so it runs on one (spec 2026-09-13, §3 and §10). Either the
   * VFS holds its database file exclusively for a connection's whole life and
   * a second worker cannot open at all (`OPFSWriteAheadVFS`), or it rotates one
   * exclusive access handle between connections and a second worker only waits
   * its turn (`OPFSAdaptiveVFS` — measured 2026-09-14 on Firefox: a pool of one
   * was faster at startup and on bursts of reads, and equal everywhere else).
   * The pool's surplus workers probe the feature before loading anything and
   * decline (`src/worker/probes.ts`); every feature listed needs a probe there.
   */
  readonly singleConnectionWithout: readonly PlatformFeature[];
  /**
   * Files this VFS keeps beside the database, by suffix, beyond the three every
   * layout may have (`''`, `-journal`, `-wal`). `deleteDatabase` removes them
   * with the rest; a file missing from this list outlives its database.
   *
   * `OPFSWriteAheadVFS` keeps its write-ahead log in two files of its own,
   * `-wa0` and `-wa1` (wa-sqlite's `#getWriteAheadNameFromDbName`) — measured
   * left behind by every deletion until 2026-09-14.
   */
  readonly extraFileSuffixes: readonly string[];
  /**
   * PRAGMAs this library applies on open for this VFS.
   *
   * Merged UNDER the consumer's `pragmas`, so any key they set wins and they
   * never lose a default by setting an unrelated one — `foreign_keys` is the
   * common case, and replacing rather than merging would silently disable
   * everything below it.
   *
   * The bar is deliberately high, and almost nothing clears it: **more
   * performance without less reliability, sourced rather than guessed.** Three
   * things were weighed and rejected. `journal_mode=wal` universally, because
   * no VFS here implements `xShmMap` and upstream gives write-ahead logging to
   * `OPFSWriteAheadVFS` alone, inside the VFS and unreachable by pragma.
   * `synchronous=normal`, because relaxing durability spends the consumer's
   * data, not their milliseconds. And `cache_size`, because raising it changes
   * a mode without a measurable gain — Firefox showed none at all, and the
   * heap it can then reach is never given back (measured 2026-09-02).
   *
   * `busy_timeout` clears it on the VFS built on WebLocksMixin, where a `BUSY`
   * means another connection holds the lock: two clients, one setting a pragma
   * that writes, met `BUSY` in up to 10 runs of 12 without it and in none with
   * it (2026-10-01). Declared first, so that it covers the pragmas after it.
   */
  readonly defaultPragmas: Readonly<Record<string, string>>;
  /**
   * PRAGMAs a client may not set on this VFS, each with the reason it is given
   * when one does — in `pragmas`, or in a statement that sets it.
   */
  readonly refusedPragmas: Readonly<Record<string, string>>;
  /**
   * A boolean PRAGMA that makes a read transaction see every committed
   * transaction, for a VFS whose reads may start one behind. The barrier sets it
   * for its own read only (`barrierSqlFor`); `null` where reads are current.
   */
  readonly catchUpPragma: string | null;
  /**
   * Whether this VFS enforces an origin-wide exclusive connection lock for the
   * client's lifetime.
   *
   * When `true`, `createSQLiteClient` acquires a `bsq:conn:…` Web Lock on first
   * use. A second client that attempts to open the same database receives `DATABASE_IN_USE`
   * immediately on its first query instead of silently reading a frozen, broken
   * view. This field is the only thing standing between a consumer and an
   * unfalsifiable silent failure — `SELECT 1` and even
   * `SELECT count(*) FROM sqlite_master` pass on a broken second client.
   *
   * `true` only for `AccessHandlePoolVFS`, whose OPFS access-handle pool is not
   * sharable across connections (measured AHP-2TAB, 2026-09-01).
   * `false` for `IDBMirrorVFS` — despite `multiConnection: false` — because two
   * clients on that VFS DO share data over its origin-wide `BroadcastChannel`
   * (measured 2026-09-01, 3/3 both engines). `multiConnection: false` there marks
   * concurrent-writer unsafety, not isolation.
   * `false` for the memory VFS, which are isolated by construction and have
   * nothing to exclude.
   *
   * `VFS_CAPABILITIES` is the single source of truth the client guard, the
   * conformance suite, the VFS.md generator and the benchmark page all read.
   * The gate is by this declaration, not by VFS name.
   */
  readonly exclusiveConnection: boolean;
  /**
   * Platform features without which this VFS holds its database file
   * exclusively for a connection's whole life, across the origin — so the
   * client takes `bsq:conn` exclusively, as for `exclusiveConnection`, and a
   * second client gets `DATABASE_IN_USE` (spec 2026-09-15).
   *
   * `OPFSWriteAheadVFS` without `readwrite-unsafe`: upstream's VFS requires the
   * mode and keeps its three access handles for the connection's life, so
   * nothing else can open the file — every query of a second client failed
   * with WORKER_CRASHED on Firefox, 20/20 per shape (2026-09-15).
   *
   * The page cannot probe these features, so worker 0 probes them before
   * opening (`src/worker/probes.ts`): every feature listed needs a probe there,
   * and must also be in `singleConnectionWithout`, whose surplus workers
   * decline before they touch the file.
   */
  readonly exclusiveConnectionWithout: readonly PlatformFeature[];
};

/**
 * The single source of truth for VFS selection. `SQLiteVFS` is derived from its
 * keys, `worker/worker.ts` must supply a loader for every key, the guards in
 * `client.ts` read it, the conformance suite gates its scenarios on it, and the
 * VFS.md table is generated from it. Nothing may hold a second copy.
 *
 * `builds` is in preference order, the same for every VFS: `sync` where the VFS
 * supports it, then `jspi`, then `async`. An omitted `build` takes the first one
 * the engine supports (`defaultBuildFor`).
 *
 * Every declared build combination is verified by running it against the pinned
 * wa-sqlite v1.1.2, never copied from upstream's table.
 */
export const VFS_CAPABILITIES = {
  OPFSWriteAheadVFS: {
    builds: ['sync', 'jspi', 'async'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    folder: 'wa',
    exclusiveFileHandle: false,
    // Measured on Firefox 2026-08-27, HAS_UNSAFE_HANDLES false: all three
    // build pairs and all six invariants pass. That campaign ran at an
    // EFFECTIVE pool of one: without readwrite-unsafe every worker but the
    // first failed to open, and conformance did not count live workers
    // (spec 2026-09-13). `requires` used to name readwrite-unsafe, which made
    // the conformance suite skip the very pairs that would have falsified it.
    // Safari behaves as Firefox — observed 2026-09-13, InvalidStateError.
    requires: ['opfs', 'sync-access-handle', 'web-locks'],
    degradesWithout: ['readwrite-unsafe'],
    singleConnectionWithout: ['readwrite-unsafe'],
    extraFileSuffixes: ['-wa0', '-wa1'],
    exclusiveConnection: false,
    exclusiveConnectionWithout: ['readwrite-unsafe'],
    defaultPragmas: {},
    refusedPragmas: {},
    // Our wa-sqlite#365, upstream: a read otherwise freezes the view
    // the BroadcastChannel has delivered, which can lag a commit.
    catchUpPragma: 'wal_read_latest',
  },
  OPFSAdaptiveVFS: {
    builds: ['jspi', 'async'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    folder: 'ad',
    exclusiveFileHandle: false,
    requires: ['opfs', 'sync-access-handle', 'web-locks'],
    degradesWithout: ['readwrite-unsafe'],
    singleConnectionWithout: ['readwrite-unsafe'],
    extraFileSuffixes: [],
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: { busy_timeout: '5000' },
    refusedPragmas: {},
    catchUpPragma: null,
  },
  OPFSCoopSyncVFS: {
    builds: ['sync', 'jspi', 'async'],
    // Capped on every engine (spec 2026-09-13, §10, D9): a pool of one was faster at startup and on bursts of reads, equal elsewhere, on Chromium and Firefox (POOL-SIZE, 2026-09-14). The handle still rotates between clients and tabs, which is why the COOPSYNC-BUSY retry stays.
    maxPoolSize: 1,
    poolLimitReason:
      'it rotates one exclusive access handle between connections, so another worker only waits its turn',
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    folder: 'cs',
    exclusiveFileHandle: true,
    requires: ['opfs', 'sync-access-handle', 'web-locks'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
    refusedPragmas: {
      busy_timeout:
        "its BUSY asks wa-sqlite to await the access handle's transfer, which a busy wait inside the worker never lets arrive",
    },
    catchUpPragma: null,
  },
  AccessHandlePoolVFS: {
    builds: ['sync', 'jspi', 'async'],
    maxPoolSize: 1,
    poolLimitReason: 'it cannot share access handles between connections',
    multiConnection: false,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    exclusiveFileHandle: true,
    requires: ['opfs', 'sync-access-handle', 'web-locks'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    // Two clients on one database break each other silently (AHP-2TAB,
    // 2026-09-01): the second resolves SELECT 1 but cannot read any table. An
    // origin-wide connection lock ensures the second client fails fast with
    // DATABASE_IN_USE instead of appearing healthy and being useless.
    exclusiveConnection: true,
    exclusiveConnectionWithout: [],
    // The one VFS that clears the bar for a default. Upstream: "there is no
    // drawback to using PRAGMA locking_mode=exclusive" here, because this VFS
    // does not allow multiple connections anyway — and exclusive locking is
    // what lets SQLite use its own WAL without shared memory, which no VFS in
    // this set provides. Measured 2026-09-02 on both engines: ~4.7x faster on
    // 200 single-statement transactions (Chromium 4.2 -> 0.9 ms/write, Firefox
    // 2.0 -> 0.5), with the access-handle pool holding the same five databases
    // either way — SQLite removes the -wal on a clean close, so it costs no
    // slot at rest. `mem:measurements`.
    defaultPragmas: { locking_mode: 'exclusive', journal_mode: 'wal' },
    refusedPragmas: {},
    catchUpPragma: null,
  },
  IDBBatchAtomicVFS: {
    builds: ['jspi', 'async'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'indexeddb',
    exclusiveFileHandle: false,
    requires: ['web-locks'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: { busy_timeout: '5000' },
    refusedPragmas: {},
    catchUpPragma: null,
  },
  IDBMirrorVFS: {
    builds: ['jspi', 'async'],
    // Measured 2026-08-25, not inferred: `CREATE TABLE` → `INSERT` → `SELECT`
    // at poolSize 2, 300 rounds under a loaded suite, failed 5 times — with
    // `no such table` (a connection not seeing a committed statement) and
    // `database is locked`. Nothing at all in 60 rounds unloaded, which is why
    // four sightings over two days never reproduced on demand. See MIRROR-1 in
    // mem:follow-ups for the method.
    //
    // It mirrors the whole database in memory PER WORKER and propagates
    // commits over BroadcastChannel, asynchronously — so a pool holds copies
    // that diverge, the same shape that had OPFSPermutedVFS removed from this
    // library. The commit barrier cannot rescue it: its prelude refreshes page
    // 1 through a real read transaction, and there is nothing fresher to read
    // on a connection whose mirror has not received the broadcast yet.
    maxPoolSize: 1,
    poolLimitReason:
      'its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright',
    multiConnection: false,
    persistent: true,
    // Upstream: "keeps all files in memory, persisting database files to
    // IndexedDB", and the whole database must fit in available memory.
    memoryModel: 'whole-database',
    storage: 'indexeddb',
    exclusiveFileHandle: false,
    requires: ['web-locks'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    // `multiConnection: false` marks concurrent-writer unsafety (MIRROR-1),
    // not isolation. Two clients share data over BroadcastChannel (measured
    // 2026-09-01, 3/3 both engines), so no exclusive lock is needed or correct.
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
    refusedPragmas: {},
    catchUpPragma: null,
  },
  OPFSAnyContextVFS: {
    builds: ['jspi', 'async'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    folder: 'ac',
    exclusiveFileHandle: false,
    requires: ['opfs', 'writable-stream', 'web-locks'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: { busy_timeout: '5000' },
    refusedPragmas: {},
    catchUpPragma: null,
  },
  MemoryVFS: {
    builds: ['sync', 'jspi', 'async'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
    storage: 'memory',
    exclusiveFileHandle: false,
    requires: [],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
    refusedPragmas: {},
    catchUpPragma: null,
  },
  MemoryAsyncVFS: {
    builds: ['jspi', 'async'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
    storage: 'memory',
    exclusiveFileHandle: false,
    requires: [],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
    refusedPragmas: {},
    catchUpPragma: null,
  },
} as const satisfies Record<string, VFSCapability>;

/**
 * The VFS's folder, or `undefined`. Read through `VFSCapability` because the
 * `as const` table narrows each entry to its own literal type, and five of
 * them have no `folder` key at all.
 */
export const folderOf = (vfs: SQLiteVFS): string | undefined => {
  const capability: VFSCapability = VFS_CAPABILITIES[vfs];
  return capability.folder;
};

export type SQLiteVFS = keyof typeof VFS_CAPABILITIES;
