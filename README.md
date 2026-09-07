# browser-sqlite

A persistent SQLite database that lives in your browser — yes, for real. Powered by [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (WebAssembly), built for (read) concurrency.

**▶ [Run the benchmarks in your own browser](https://lalexdotcom.github.io/browser-sqlite/)** — every
VFS this library ships, put through the same conformance checks and measurements, on your device.
It is the honest way to choose one: which VFS wins depends on the engine, and it changes often —
a single browser release can move the answer.

## Install

```bash
npm install browser-sqlite
# or
pnpm add browser-sqlite
```

Requires a bundler that supports Web Workers with dynamic imports — or no bundler at all.

<details>
<summary><b>Bundler Configuration</b></summary>

Works with no configuration under **rsbuild 1+**, **rspack 1+**, **Parcel 2+**, **Vite 8+**, **webpack 5.101+** — and with no bundler at all.

Works under **Vite 6.1 to 7** with the following config, which only the dev server needs:

```typescript
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['browser-sqlite'] },
});
```

Another bundler will likely work — the worker and its `.wasm` are reached through plain, statically analysable URLs — but may need configuration of its own.

The `.wasm` are read from beside `worker.js`. If a build separates them, or you move them by hand, point at them with [`wasmUrl`](API.md#options).
</details>

## Browser support

| Chrome | Firefox | Safari |
|---|---|---|
| 92+ | 95+ | 15.4+ |

browser-sqlite requires no special HTTP headers. OPFS access handles work in a plain
worker context, and every VFS runs on a page served without cross-origin isolation. The
default build needs no browser opt-in either; only `build: 'jspi'` does, and that is a
browser constraint rather than a header requirement.

Cross-origin isolation is worth adding where you control your headers: it is what lets an
aborted call stop the statement SQLite is already running, on the VFS that default to the
`sync` build. It is an option rather than a requirement, and it has a cost of its own —
both are set out under [Aborting a call](#aborting-a-call).

## Usage

```typescript
import { createSQLiteClient } from 'browser-sqlite';

const db = createSQLiteClient('myapp.sqlite', { vfs: 'OPFSAdaptiveVFS' });

await db.write('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
await db.write('INSERT INTO users (name) VALUES (?)', ['Alice']);

const users = await db.read<{ id: number; name: string }>('SELECT id, name FROM users');

for await (const row of db.stream<{ id: number; name: string }>('SELECT * FROM users')) {
  process(row);
}

await db.close();
```

Nothing is deleted by `close()` — [`deleteDatabase`](API.md#deletedatabase) is what removes
a database.

Every method, property and option is in
[the detailed API documentation](API.md) — transactions, bulk loading, aborting a query and
the error codes.

[*client*.id](API.md#clientid) · [*client*.name](API.md#clientname) · [*client*.file](API.md#clientfile) · [*client*.vfs](API.md#clientvfs) · [*client*.build](API.md#clientbuild)

[createSQLiteClient()](API.md#createsqliteclient) · [*client*.read()](API.md#clientread) · [*client*.write()](API.md#clientwrite) · [*client*.stream()](API.md#clientstream) · [*client*.chunk()](API.md#clientchunk) · [*client*.first()](API.md#clientfirst) · [*client*.transaction()](API.md#clienttransaction) · [*client*.bulkWrite()](API.md#clientbulkwrite) · [*client*.output()](API.md#clientoutput) · [*client*.inspect()](API.md#clientinspect) · [*client*.close()](API.md#clientclose) · [deleteDatabase()](API.md#deletedatabase) · [inspectDatabase()](API.md#inspectdatabase)

## Storage

The VFS decides *where* your database is written, and it is required at client creation.
Pass `OPFSAdaptiveVFS` unless you have a reason not to — it is the only one that opened and
passed every conformance check on every engine we could test.

[See every available VFS on the dedicated page](VFS.md), with their pros, their cons, their
limitations and their browser compatibility.

## Guarantees

### Reads run concurrently

Every read is dispatched to whichever worker in the pool is free, so several run at once.
Writes take a dedicated writer worker instead, one at a time.

### Read-your-own-writes

It holds within a tab and across tabs. Once a write has resolved, any read issued afterwards
observes it — from that client, from any other client in the same tab, and from any other tab
on the same database, whatever the pool size. A worker that has not yet observed the latest
commit runs one discarded statement that opens a real read transaction before it serves the
query; that costs one extra worker round-trip on each worker's first statement after a write,
and nothing under read-only load. `poolSize: 1` and reading inside the same `transaction()`
remain valid, they are no longer required.

The one exception is [`IDBMirrorVFS`](VFS.md#idbmirrorvfs), which does not hold it across
tabs.

### Writes are serialized

A write, a write transaction, and each batch of a `bulkWrite` take one lock per database
across the whole origin, so a second writer **waits** rather than failing — between clients
and between tabs alike. The wait is unbounded and first-come-first-served: pass a `signal` if
you would rather fail than wait. A write transaction holds that lock for the whole of its
callback, so a callback that never returns blocks every other writer in the origin, not only
its own client. **A `bulkWrite` takes the lock per batch and commits per batch**, so another
client's write can land between two of its batches — use `tx.bulkWrite` where you need all or
nothing.

## Known Limitations

Some VFS have limitations of their own — see [the detailed VFS page](VFS.md#per-vfs-notes).
What follows holds on all of them.

### Aborting a call

An abort does not always stop the work, and your hosting decides. On the `sync` build — the
default behind `OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS` and
`MemoryVFS` — a `signal` or a `timeout` rejects your promise straight away, but the
statement runs to its end on its worker, which stays unavailable until it does.

Serving the page **cross-origin isolated** is what lets an abort reach the running
statement. Two header sets do it, and each costs something:

- **`Cross-Origin-Opener-Policy: same-origin` together with
  `Cross-Origin-Embedder-Policy: require-corp`** — works in every engine. Every cross-origin
  subresource must then opt in through `Cross-Origin-Resource-Policy` or CORS, so
  third-party images, fonts, scripts and iframes stop loading unless they cooperate; and
  `same-origin` severs the opener link with cross-origin popups, which breaks sign-in and
  payment windows that depend on it.
- **`Document-Isolation-Policy: isolate-and-require-corp`** — Chromium only; Firefox ignores
  it, so it cannot be your only measure on a cross-browser deployment. Cross-origin
  subresources still need `Cross-Origin-Resource-Policy`, but no `Cross-Origin-Opener-Policy`
  is involved, so popups and opener relationships keep working and the isolation applies to
  this document rather than to everything around it.

Where neither is worth it, `build: 'async'` buys the same interruption on all four VFS and
needs no hosting change — but it is slower wherever a query walks rows: full scans and paged
reads take roughly twice as long, from half again on Safari to nearly three times on Firefox,
and bulk inserts about a quarter longer. Point reads, write latency and read concurrency are
unaffected. See [Interrupting a call](API.md#interrupting-a-call).

### Deleting a database

A database that any client still holds cannot be deleted, in this tab or another, on every
VFS. `deleteDatabase` reports `DATABASE_IN_USE` immediately rather than deleting under a live
connection, and reports `BUSY` when an open or another delete is merely in flight — the first
means close it, the second means retry. **Closing every client on the database is what
releases it**, so a client your application has stopped using but never closed keeps blocking
until its tab goes. This library cannot revoke a connection it did not open: another library
or native code on the same origin is invisible to it.

## Development

```bash
pnpm install
pnpm build          # rslib → dist/
pnpm test           # unit (Node) + browser (Playwright/Chromium)
pnpm check          # biome, with --write
```

Two suites run on demand rather than on every change:

```bash
pnpm test:conformance   # every declared (vfs, build) pair through six invariants
pnpm test:consumer      # packs the tarball and drives four bundler modes
```

### The benchmark page

`scripts/bench/html/index.html` is the page published above. It is one self-contained file
served beside a verbatim copy of `dist/`, so it exercises the library exactly as
a consumer would with no bundler at all.

```bash
pnpm bench:dev      # build, serve on http://127.0.0.1:8099, rebuild on change
pnpm bench:serve    # same without the watch
pnpm bench:build    # assemble _site/ only
```

`http://127.0.0.1` is a secure context, so OPFS works with no certificate — no
TLS setup is needed to develop against it. A phone on the LAN is a different
matter: it is not a secure context, so OPFS is unavailable there and a tunnel
(or the published page) is the way to test a real device.

`node scripts/bench/check.mjs [chromium|firefox] [--all]` drives the page under
Playwright and asserts that it still works — it is run by hand and deliberately
not wired into CI. It checks the *page*, never that a VFS passes: a red cell can
be a correct report about the engine you are on.
