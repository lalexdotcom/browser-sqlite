// Reproduction for https://github.com/rhashimoto/wa-sqlite/issues/341, against
// this repository rather than the @journeyapps fork.
//
//   npm i playwright        (or: yarn add -D playwright)
//   node repro-341.mjs [runs]
//
// Run it from the root of a wa-sqlite checkout: dist/ is committed, so nothing
// has to be built.
//
// Four module workers open the same fresh OPFS file and migrate it
// concurrently. Expected: all four settle, with success or SQLITE_BUSY.
// Observed on master: some runs never settle.
//
// Two deviations from the script in the issue, both noted where they appear:
// the workers announce themselves before being given work, and CREATE TABLE is
// IF NOT EXISTS.
//
// After a hang the page is closed -- which terminates the hung workers and
// releases their access handles -- and one fresh connection then runs the same
// workload on the same file in the same browser context, to test the
// "poisoned lock file" part of the report.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8765;
const ROOT = process.cwd();
const RUNS = Number(process.argv[2] ?? 1);
const DEADLINE = 12000;

const WORKER_SRC = `
  import SQLiteESMFactory from '/dist/wa-sqlite.mjs';
  import * as SQLite from '/src/sqlite-api.js';
  import { OPFSCoopSyncVFS } from '/src/examples/OPFSCoopSyncVFS.js';
  import { SQLITE_OPEN_READWRITE, SQLITE_OPEN_CREATE } from '/src/sqlite-constants.js';
  const module = await SQLiteESMFactory({ locateFile: (f) => '/dist/' + f });
  const sqlite3 = SQLite.Factory(module);
  const vfs = await OPFSCoopSyncVFS.create('opfs', module);
  sqlite3.vfs_register(vfs, true);
  // The worker announces itself instead of the page posting straight away: this
  // worker uses top-level await, and a message posted before the module has
  // finished evaluating is dropped, not queued. The script in the issue posts
  // immediately, so its workers never receive their task and every run reports
  // HANG:0 whatever the VFS does.
  self.postMessage({ ready: true });
  self.onmessage = async (ev) => {
    const { id, filename } = ev.data;
    try {
      const db = await sqlite3.open_v2(filename, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
      // IF NOT EXISTS: without it the losers report "table t already exists",
      // which is settled but noisy.
      await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS t (i INTEGER)');
      await sqlite3.exec(db, 'BEGIN');
      for (let i = 0; i < 200; i++) await sqlite3.exec(db, 'INSERT INTO t (i) VALUES (' + i + ')');
      await sqlite3.exec(db, 'COMMIT');
      self.postMessage({ id, status: 'ok' });
    } catch (e) {
      self.postMessage({ id, status: 'error', message: String((e && e.message) || e) });
    }
  };
`;

const PAGE = `<!DOCTYPE html>
<html><body><script type="module">
const params = new URLSearchParams(location.search);
const filename = params.get('file');
const n = Number(params.get('n'));
const results = new Array(n).fill(null);
const settle = (v) => { if (!document.body.dataset.result) document.body.dataset.result = v; };
const deadline = setTimeout(() => {
  settle('HANG:' + results.map(r => r ?? '-').join(','));
}, ${DEADLINE});
Array.from({ length: n }, (_, id) => {
  const w = new Worker('/worker.mjs', { type: 'module' });
  w.onerror = (e) => settle('WORKER_ERROR:' + (e.message || e));
  w.onmessage = (ev) => {
    if (ev.data.ready) { w.postMessage({ id, filename }); return; }
    results[ev.data.id] = ev.data.status === 'ok' ? 'ok' : 'error(' + ev.data.message + ')';
    if (results.every(r => r !== null)) {
      clearTimeout(deadline);
      settle('DONE:' + results.join(','));
    }
  };
});
</script></body></html>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  // OPFS sync access handles need a worker; COOP/COEP matches the original report.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const p = normalize(decodeURIComponent(url.pathname));
  if (p === '/') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
  if (p === '/worker.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(WORKER_SRC); return; }
  if (p.startsWith('/dist/') || p.startsWith('/src/')) {
    try {
      const buf = await readFile(join(ROOT, p));
      res.setHeader('Content-Type', TYPES[extname(p)] ?? 'application/octet-stream');
      res.end(buf);
      return;
    } catch {}
  }
  res.statusCode = 404;
  res.end('not found');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

async function attempt(context, filename, n) {
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?file=${filename}&n=${n}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.result, undefined, { timeout: DEADLINE + 20000 });
    return await page.evaluate(() => document.body.dataset.result);
  } catch (e) {
    return 'DRIVER_TIMEOUT';
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
let hangs = 0;
try {
  for (let run = 1; run <= RUNS; run++) {
    const context = await browser.newContext();
    const filename = `repro-${Date.now()}-${run}.db`;
    const result = await attempt(context, filename, 4);
    let poison = '';
    if (result.startsWith('HANG') || result === 'DRIVER_TIMEOUT') {
      hangs++;
      // Same context, same origin, same file, hung workers gone.
      poison = `  fresh connection afterwards: ${await attempt(context, filename, 1)}`;
    }
    await context.close();
    console.log(`run ${run}: ${result}${poison}`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${hangs}/${RUNS} runs hung`);
process.exit(hangs ? 1 : 0);
