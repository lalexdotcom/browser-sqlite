# Follow-up — let the client survive the back/forward cache by itself

**Status: DEFERRED** — 2026-11-02 (user): a new behaviour, moved after the current release, which is bugfix only. Not designed.

Part of `mem:follow-ups`, opened 2026-11-02 from the #386 test's design (`mem:follow-ups/wa-sqlite-386-coopsync-bfcache`).

## Why

**On Safari 27.2 a page in the back/forward cache keeps its workers' Web Locks and OPFS handles**, so the next page of the same site that opens the same database fails (measured 2026-11-02 on the user's Mac through a probe page served from the container, 5 pages per VFS, each keeping its client open and navigating to the next; every page left with `pagehide.persisted === true`):

- `OPFSCoopSyncVFS` (`sync`) and `OPFSAdaptiveVFS` (`jspi`): `TIMEOUT` after `openTimeout` (10 s in the probe, 30 s by default) on pages 2, 3 and 5; page 4 opened (Safari had evicted page 1 by then).
- `OPFSWriteAheadVFS` (`sync`): `WORKER_CRASHED` at once (~35 ms), `InvalidStateError` — a first open does not retry a held file.
- `IDBBatchAtomicVFS` (`jspi`): every page opened.
- With `API.md`'s advice (`db.close()` on `pagehide`), `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` opened on all 5 pages, and the pages still entered the cache.

wa-sqlite alone shows the same on Safari: the cached page's worker keeps `ahp:/<file>` and its `.ahp-*` lock, the next page's `open_v2()` waits on it for good; `OPFSCoopSyncVFS.create()` itself succeeds (the sweep skips the locked directory), so #362 does not arise on Safari. Chrome 156 (macOS) instead reaches #362 (upstream fails every other page, #386 fixes it), i.e. it does not keep the cached page's lock against the next page. Whether the Web Locks or HTML specs require evicting a cached page whose lock is requested is not checked: a possible WebKit report.

## The idea and what it costs

The client listens to `pagehide` with `persisted === true`, closes its workers (freeing locks and handles) while staying usable, and restarts them on `pageshow` with `persisted === true`. Costs and decisions (user agreed it is a feature, 2026-11-02):

- work in flight at `pagehide` (a transaction, a `stream()`/`chunk()`): SQLite rolls back, but the restored page holds pending promises that need a dedicated rejection — a new error in the API;
- session state the application set with `run()` (`TEMP` tables, `PRAGMA`s, attached databases) is lost; the library's own pragmas are replayed as after a crash;
- `MemoryVFS`/`MemoryAsyncVFS` must be left alone (closing erases the database; they hold nothing);
- a Back navigation is no longer instant: the first query waits for the workers (~40-100 ms plus the WASM instantiation);
- Chrome would change too (today a cached page keeps a live client and restores instantly): opt-in, or Safari-only, to decide;
- cross-tab coordination must see the client leave and come back;
- tests need a real top-level navigation on Chrome and Safari — the harness the #386 test needs;
- unknown: `close()` called from `pagehide` sufficed in the probe although it is asynchronous and the page freezes right after — whether it terminates the workers at once or won a race is not known.

Meanwhile (2026-11-02, `fix/bfcache-held-database`): `API.md` says to reopen on `pageshow` too, and a first open that meets a held file says so.
