# Follow-up — wa-sqlite #387: `getIDBFactory` and `prefix` for the IndexedDB VFS — PR open

**Status: OPEN** — PR open, waiting for review.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

Opened 2026-10-23, branch `idb-factory-prefix` of the fork; report `docs/upstream/2026-10-23-wa-sqlite-387-idb-factory-prefix.md`. **Rebased onto `master` `66336807` on 2026-10-25** after #385 merged (`516b3080`, the import conflict in `test/IDBMirrorVFS.test.js` resolved by keeping both; suite green on Chrome; note on the PR). Nothing owed until his review. If rhashimoto wants `prefix` kept out of `WebLocksMixin`'s other users, he says so on the PR (user). A Mirror-only test of `#getOldestTxInUse()` (no test covers it, prefixed or not) was offered to rhashimoto on the PR (2026-10-23, issuecomment-6370990190): written if he wants it.
