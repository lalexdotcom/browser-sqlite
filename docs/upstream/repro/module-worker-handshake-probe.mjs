// Does a module worker receive a message posted before it finished evaluating?
//
// It does not, when the worker uses top-level await: the message is dropped,
// not queued (Chromium 151, Firefox 153 — measured 2026-09-16). The worker
// posts a mark at each stage; `message-received` never appears.
//
//   node module-worker-handshake-probe.mjs /path/to/wa-sqlite [engine]
//
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import * as pw from 'playwright';

// node module-worker-handshake-probe.mjs <wa-sqlite-checkout> [chromium|firefox|webkit]
const engine = pw[process.argv[3] ?? 'chromium'];
const PORT = 8899, ROOT = process.argv[2];
const WORKER_SRC = `
  self.postMessage({ mark: 'worker-top' });
  import SQLiteESMFactory from '/dist/wa-sqlite.mjs';
  import * as SQLite from '/src/sqlite-api.js';
  import { OPFSCoopSyncVFS } from '/src/examples/OPFSCoopSyncVFS.js';
  self.postMessage({ mark: 'imports-done' });
  const module = await SQLiteESMFactory({ locateFile: (f) => '/dist/' + f });
  self.postMessage({ mark: 'factory-done' });
  const sqlite3 = SQLite.Factory(module);
  const vfs = await OPFSCoopSyncVFS.create('opfs', module);
  sqlite3.vfs_register(vfs, true);
  self.postMessage({ mark: 'vfs-ready' });
  self.onmessage = (ev) => { self.postMessage({ mark: 'message-received', data: ev.data }); };
  self.postMessage({ mark: 'handler-installed' });
`;
const PAGE = `<!DOCTYPE html><html><body><script type="module">
window.__marks = [];
const w = new Worker('/worker.mjs', { type: 'module' });
w.onerror = (e) => window.__marks.push({ mark: 'ONERROR', message: e.message || String(e) });
w.onmessage = (ev) => window.__marks.push(ev.data);
w.postMessage({ id: 0, filename: 'diag.db' });   // posted immediately, as in the report's script
setTimeout(() => { document.body.dataset.done = '1'; }, 5000);
</script></body></html>`;
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const p = normalize(decodeURIComponent(url.pathname));
  if (p === '/') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
  if (p === '/worker.mjs') { res.setHeader('Content-Type', 'text/javascript'); res.end(WORKER_SRC); return; }
  if (p.startsWith('/dist/') || p.startsWith('/src/')) {
    try { const b = await readFile(join(ROOT, p)); res.setHeader('Content-Type', TYPES[extname(p)] ?? 'application/octet-stream'); res.end(b); return; } catch (e) { console.log('404', p); }
  }
  res.statusCode = 404; res.end('nf');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const browser = await engine.launch();
const page = await browser.newPage();
page.on('console', m => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.body.dataset.done, undefined, { timeout: 20000 }).catch(() => {});
console.log(JSON.stringify(await page.evaluate(() => window.__marks), null, 1));
await browser.close(); server.close();
