# browser-sqlite

A persistent SQLite database that lives in your browser — yes, for real. Powered by [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (WebAssembly), built for (read) concurrency.

A client stores its data through a wa-sqlite VFS, which decides where that data lives. **[Read the VFS page](VFS.md)** to compare them, then **[run the benchmarks in your own browser](https://lalexdotcom.github.io/browser-sqlite/)**.

## Opinionated by design

browser-sqlite makes choices for you, so that one database stays correct while several workers, clients and tabs use it. You will meet each of them as a refusal or a wait if you do not know them, so here they are:

- **One writer at a time, across the origin.** Every write takes a lock per database shared by every client and every tab; a second writer waits its turn. See [Writes are serialized](#writes-are-serialized).
- **Reads and writes go through different methods.** `read()`, `stream()`, `chunk()` and `first()` accept only a statement that is provably a read; everything else goes through `write()`.
- **Transactions belong to the library.** `BEGIN`, `COMMIT`, `ROLLBACK` and savepoints sent as SQL are refused: use [`transaction()`](API.md#clienttransaction) and `tx.savepoint()`. A write transaction always opens with `BEGIN IMMEDIATE`, a `readOnly` one with a plain `BEGIN`.
- **The build follows the browser.** Leave `build` out and each VFS loads the first build it declares that the engine supports.

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
| 92+ | 90+ | 15.4+ |

Cross-origin isolation is worth adding where you control your headers: it is what lets an aborted call stop a running statement when using a VFS with `sync` build. See [Aborting a call](#aborting-a-call).

## Usage

Read the [detailed API documentation](API.md) for the full description.

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

[*client*.id](API.md#clientid) · [*client*.name](API.md#clientname) · [*client*.file](API.md#clientfile) · [*client*.files](API.md#clientfiles) · [*client*.vfs](API.md#clientvfs) · [*client*.build](API.md#clientbuild) · [*client*.poolSize](API.md#clientpoolsize) · [*client*.ready](API.md#clientready) · [*client*.debug](API.md#clientdebug)

[createSQLiteClient()](API.md#createsqliteclient) · [*client*.read()](API.md#clientread) · [*client*.write()](API.md#clientwrite) · [*client*.stream()](API.md#clientstream) · [*client*.chunk()](API.md#clientchunk) · [*client*.first()](API.md#clientfirst) · [*client*.transaction()](API.md#clienttransaction) · [*client*.bulkWrite()](API.md#clientbulkwrite) · [*client*.output()](API.md#clientoutput) · [*client*.inspect()](API.md#clientinspect) · [*client*.close()](API.md#clientclose) · [deleteDatabase()](API.md#deletedatabase) · [inspectDatabase()](API.md#inspectdatabase)

## Storage

The VFS decides *where* your database is written. [See every available VFS on the dedicated page](VFS.md), with their pros, their cons, their limitations and their browser compatibility.

`OPFSWriteAheadVFS` and `OPFSAdaptiveVFS` are the recommended options.

[`OPFSWriteAheadVFS`](VFS.md#opfswriteaheadvfs) · [`OPFSAdaptiveVFS`](VFS.md#opfsadaptivevfs) · [`OPFSCoopSyncVFS`](VFS.md#opfscoopsyncvfs) · [`AccessHandlePoolVFS`](VFS.md#accesshandlepoolvfs) · [`IDBBatchAtomicVFS`](VFS.md#idbbatchatomicvfs) · [`IDBMirrorVFS`](VFS.md#idbmirrorvfs) · [`OPFSAnyContextVFS`](VFS.md#opfsanycontextvfs) · [`MemoryVFS`](VFS.md#memoryvfs) · [`MemoryAsyncVFS`](VFS.md#memoryasyncvfs)

## Guarantees

### Reads run concurrently

Every read is dispatched to whichever worker in the pool is free, so several run at once. Writes take a dedicated writer worker instead, one at a time.

### Read-your-own-writes

Once a write has resolved, any read issued afterwards observes it — from any client, in this tab or another, whatever the pool size. The one exception is [`IDBMirrorVFS`](VFS.md#idbmirrorvfs), which does not hold it across tabs.

### Writes are serialized

`write()`, a write `transaction()` and each batch of a `bulkWrite()` take one lock per database, across every client and tab: a second writer waits its turn, unbounded unless you pass a `signal` or a `timeout`. A transaction holds the lock for its whole callback, so keep it short. A `bulkWrite()` commits per batch — use `tx.bulkWrite()` for all or nothing.

## Known Limitations

Some VFS have limitations of their own — see [the detailed VFS page](VFS.md#vfs-reference). What follows holds on all of them.

### Aborting a call

An abort does not always stop the work, and your hosting decides. On the `sync` build, a `signal` or a `timeout` rejects your promise straight away, but the statement runs to its end on its worker, which stays unavailable until it does.

Serving the page cross-origin isolated gets you out, and so does any build other than `sync`; what each one costs is under [Interrupting a call](API.md#interrupting-a-call).

### Deleting a database

A database that any client still holds cannot be deleted, in this tab or another, on every VFS. More on the dedicated [`deleteDatabase`](API.md#deletedatabase) API entry.

## Development

```bash
pnpm install
pnpm build          # rslib → dist/
pnpm test           # unit (Node) + browser (Playwright: Chromium, Firefox)
pnpm check          # biome, with --write
```

These suites run on demand rather than on every change:

```bash
pnpm test:conformance   # every declared (vfs, build) pair through the same invariants
pnpm test:consumer      # packs the tarball and runs it under each supported bundler, and with none
```

### The benchmark page

`scripts/bench/html/index.html` is the page published above. It is one self-contained file served beside a verbatim copy of `dist/`, so it exercises the library exactly as a consumer would with no bundler at all.

```bash
pnpm bench:dev      # build, serve on http://127.0.0.1:8099, rebuild on change
pnpm bench:serve    # same without the watch
pnpm bench:build    # assemble _site/ only
```

`http://127.0.0.1` is a secure context, so OPFS works with no certificate — no TLS setup is needed to develop against it. A phone on the LAN is a different matter: it is not a secure context, so browsers withhold OPFS and the Web Locks API there, and only `MemoryVFS` and `MemoryAsyncVFS` run. A tunnel (or the published page) is the way to test a real device.

`node scripts/bench/check.ts [chromium|firefox] [--all]` drives the page under Playwright and asserts that it still works — it is run by hand and deliberately not wired into CI. It checks the *page*, never that a VFS passes: a red cell can be a correct report about the engine you are on.
