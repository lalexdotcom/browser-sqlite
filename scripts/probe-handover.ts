/**
 * THROWAWAY (ci/windows-macos): the OPFSCoopSyncVFS hand-over, reduced to
 * OPFS and Web Locks. Worker A takes a Web Lock, opens a sync access handle,
 * writes, closes it and releases the lock; worker B, queued on the same lock,
 * opens a handle on the same file the moment it is granted. Counts how often
 * B's first createSyncAccessHandle() fails although A closed before letting
 * go, and how long B then waits for the file to be free.
 *
 *   node scripts/probe-handover.ts [chrome,firefox]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';
import {
  browserCapabilities,
  parseBrowserList,
  WDIO_CACHE_DIR,
} from './browsers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8138;
const ROUNDS = 30;

const WORKER = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
onmessage = async ({ data: { role, round, kill } }) => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('handover', { create: true });
  if (role === 'A') {
    await navigator.locks.request('handover', async () => {
      postMessage({ granted: true });
      const h = await fh.createSyncAccessHandle();
      h.write(new Uint8Array([round]), { at: 0 });
      h.flush();
      if (kill) {
        postMessage({ holding: true });
        await new Promise(() => {});
      }
      h.close();
    });
    postMessage({ done: true });
    return;
  }
  await navigator.locks.request('handover', async () => {
    const t0 = performance.now();
    let first = 'ok';
    for (let attempt = 0; ; attempt++) {
      try {
        const h = await fh.createSyncAccessHandle();
        h.close();
        postMessage({ done: true, first, waited: performance.now() - t0, attempts: attempt + 1 });
        return;
      } catch (e) {
        if (attempt === 0) first = e.name;
        if (performance.now() - t0 > 5000) {
          postMessage({ done: true, first, waited: -1, attempts: attempt + 1 });
          return;
        }
        await sleep(5);
      }
    }
  });
};`;

const PAGE = `<!doctype html><script>
const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' }));
const next = (w) => new Promise((r) => { w.onmessage = (e) => r(e.data); });
const run = async (kill) => {
  const out = [];
  const b = new Worker(url);
  for (let round = 0; round < ${ROUNDS}; round++) {
    const a = new Worker(url);
    const aGranted = next(a);
    a.postMessage({ role: 'A', round, kill });
    await aGranted;
    const aNext = next(a);
    const bDone = next(b);
    b.postMessage({ role: 'B', round });
    await aNext;
    if (kill) a.terminate();
    out.push(await bDone);
    if (!kill) a.terminate();
  }
  b.terminate();
  return out;
};
window.__probe = (async () => ({ close: await run(false), terminate: await run(true) }))();
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'probe-handover-'));
writeFileSync(join(dir, 'index.html'), PAGE);
const server = spawn(
  process.execPath,
  [join(ROOT, 'scripts/static-server.ts'), dir, String(PORT)],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1000));

type Round = { first: string; waited: number; attempts: number };

try {
  for (const name of parseBrowserList(process.argv[2])) {
    const browser = await remote({
      logLevel: 'error',
      cacheDir: WDIO_CACHE_DIR,
      capabilities: {
        ...browserCapabilities(name),
        ...(name === 'chrome'
          ? { 'goog:chromeOptions': { args: ['--headless=new'] } }
          : { 'moz:firefoxOptions': { args: ['-headless'] } }),
      },
    });
    try {
      await browser.url(`http://localhost:${PORT}/index.html`);
      const result = (await browser.execute(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as Record<string, Round[]>;
      for (const [mode, rounds] of Object.entries(result)) {
        const failed = rounds.filter((r) => r.first !== 'ok');
        const names = [...new Set(failed.map((r) => r.first))].join(', ');
        const waits = failed.map((r) => r.waited).sort((x, y) => x - y);
        console.log(
          `${name} on ${process.platform}, A ${mode === 'close' ? 'closes' : 'is terminated holding it'}: B's first open failed ${failed.length}/${rounds.length}` +
            (failed.length
              ? ` (${names}); free after median ${waits[Math.floor(waits.length / 2)]?.toFixed(0)} ms, max ${waits.at(-1)?.toFixed(0)} ms, never: ${failed.filter((r) => r.waited < 0).length}`
              : ''),
        );
      }
    } finally {
      await browser.deleteSession();
    }
  }
} finally {
  server.kill();
}
