// Reproduction for the OPFSCoopSyncVFS access-handle leak: one failed
// acquisition leaves the VFS instance holding a sidecar file, so every later
// open of the same database fails — on `-journal`, held by the very instance
// asking for it.
//
//   npm i playwright        (or: yarn add -D playwright)
//   node coopsync-access-handle-leak.mjs [runs]
//
// Run it from the root of a wa-sqlite checkout: dist/ is committed, so nothing
// has to be built.
//
// The sequence, all in one browser context:
//
//   1. a holder worker takes an EXCLUSIVE access handle on /demo
//      (createSyncAccessHandle with no mode), which is what a VFS in another
//      context — or a worker that has just been terminated — would hold;
//   2. a second worker creates an OPFSCoopSyncVFS and opens 'demo'. It fails,
//      which is expected and not the subject;
//   3. the holder closes its handle, so the file is free;
//   4. the SAME VFS instance opens 'demo' again.
//
// Step 4 is the subject. Expected: it succeeds. Observed on master: it fails,
// and keeps failing. Step 5 then asks which files are actually held, from a
// third context: `demo` is free, `demo-journal` is not — and the only thing
// still running that could hold it is the VFS of step 2.
//
// Exit code 0 means the defect did NOT reproduce (step 4 succeeded).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8770;
const ROOT = process.cwd();
const RUNS = Number(process.argv[2] ?? 1);

// Classic workers: no module, no top-level await, so no dropped first message
// (see module-worker-handshake-probe.mjs for why that matters here).
const HOLDER_SRC = `
  let handle = null;
  self.onmessage = async ({ data }) => {
    if (data.type === 'take') {
      try {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle(data.name, { create: true });
        handle = await file.createSyncAccessHandle();
        self.postMessage({ ok: true });
      } catch (e) {
        self.postMessage({ ok: false, error: e.name });
      }
    } else {
      try { handle?.close(); } catch {}
      handle = null;
      self.postMessage({ ok: true });
    }
  };
`;

// Asks which of the database's files can be acquired right now. A file that
// refuses is held by something still alive in this browser context.
const PROBE_SRC = `
  self.onmessage = async ({ data }) => {
    const held = [];
    const root = await navigator.storage.getDirectory();
    for (const suffix of ['', '-journal', '-wal']) {
      const name = data.name + suffix;
      try {
        const file = await root.getFileHandle(name);
        const h = await file.createSyncAccessHandle();
        h.close();
      } catch (e) {
        if (e.name !== 'NotFoundError') held.push(name);
      }
    }
    self.postMessage({ held });
  };
`;

const VFS_SRC = `
  import SQLiteESMFactory from '/dist/wa-sqlite.mjs';
  import * as SQLite from '/src/sqlite-api.js';
  import { OPFSCoopSyncVFS } from '/src/examples/OPFSCoopSyncVFS.js';
  const module = await SQLiteESMFactory({ locateFile: (f) => '/dist/' + f });
  const sqlite3 = SQLite.Factory(module);
  const vfs = await OPFSCoopSyncVFS.create('demo-vfs', module);
  sqlite3.vfs_register(vfs, true);
  self.onmessage = async ({ data }) => {
    try {
      const db = await sqlite3.open_v2(data.name);
      await sqlite3.close(db);
      self.postMessage({ ok: true });
    } catch (e) {
      self.postMessage({ ok: false, error: e.message });
    }
  };
  // Announced only once the handler is installed: a message posted before a
  // module worker finishes evaluating is dropped, not queued.
  self.postMessage({ ready: true });
`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>coopsync handle leak</title>`;

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};

const WORKERS = {
  '/holder.js': HOLDER_SRC,
  '/probe.js': PROBE_SRC,
  '/vfs.mjs': VFS_SRC,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE);
  }
  // Workers are served from a URL rather than a blob: a module worker built
  // from a blob resolves its imports against the blob URL, which is not what
  // `/dist/...` needs.
  if (WORKERS[url.pathname]) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(WORKERS[url.pathname]);
  }
  try {
    const path = join(ROOT, normalize(url.pathname));
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

async function runOnce(context, run) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);

  page.on('pageerror', (e) => console.log(`         page error: ${e.message}`));

  const result = await page.evaluate(async () => {
      const name = 'demo';
      // Every wait is bounded and watches for failure: a worker that throws
      // while loading would otherwise leave the whole run pending with no
      // reason given.
      const next = (worker, what) =>
        new Promise((resolve, reject) => {
          const bound = setTimeout(
            () => reject(new Error(`timed out waiting for ${what}`)),
            10000,
          );
          const done = (fn) => (value) => {
            clearTimeout(bound);
            fn(value);
          };
          worker.addEventListener('message', (e) => done(resolve)(e.data), {
            once: true,
          });
          worker.addEventListener(
            'error',
            (e) =>
              done(reject)(
                new Error(`${what} failed: ${e.message ?? 'worker error'}`),
              ),
            { once: true },
          );
        });

      try {
        const holder = new Worker('/holder.js');
        holder.postMessage({ type: 'take', name });
        const taken = await next(holder, 'holder take');
        if (!taken.ok) {
          return { skipped: `holder could not take: ${taken.error}` };
        }

        const vfs = new Worker('/vfs.mjs', { type: 'module' });
        await next(vfs, 'vfs worker startup');

        vfs.postMessage({ name });
        const first = await next(vfs, 'first open');

        holder.postMessage({ type: 'release' });
        await next(holder, 'holder release');

        vfs.postMessage({ name });
        const second = await next(vfs, 'second open');

        const probe = new Worker('/probe.js');
        probe.postMessage({ name });
        const { held } = await next(probe, 'held-files probe');

        return { first, second, held };
      } catch (e) {
        return { skipped: e.message };
      }
  });

  await page.close();

  if (result.skipped) {
    console.log(`run ${run}: SKIPPED — ${result.skipped}`);
    return null;
  }
  const { first, second, held } = result;
  console.log(
    `run ${run}: open while held = ${first.ok ? 'ok' : 'failed'}` +
      ` | open after release = ${second.ok ? 'OK' : 'FAILED'}` +
      ` | still held afterwards: ${held.length ? held.join(', ') : 'none'}`,
  );
  if (!second.ok) console.log(`         ${second.error}`);
  return second.ok;
}

const browser = await chromium.launch();
let reproduced = 0;
let counted = 0;
try {
  for (let run = 1; run <= RUNS; ++run) {
    // A fresh context per run: its own OPFS, so no run inherits another's files.
    const context = await browser.newContext();
    const ok = await runOnce(context, run);
    await context.close();
    if (ok === null) continue;
    counted++;
    if (!ok) reproduced++;
  }
} finally {
  await browser.close();
  server.close();
}

console.log(
  `\n${reproduced} of ${counted} runs failed to reopen after the file was released.`,
);
process.exit(reproduced ? 1 : 0);
