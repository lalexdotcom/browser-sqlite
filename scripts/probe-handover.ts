/**
 * THROWAWAY (ci/windows-macos): a sync access handle's holder and the next
 * one, reduced to OPFS and Web Locks.
 *
 * Hand-over: worker A takes a Web Lock and a handle; worker B queues on the
 * lock and opens a handle the moment it is granted. A ends three ways: it
 * closes then releases (close), it is terminated while awaiting (idle), inside
 * a JavaScript loop (busy), or inside a WebAssembly loop (wasm). Counts B's failed first
 * attempts and how long the file stays held.
 *
 * Names: what createSyncAccessHandle() and removeEntry() throw on a file a
 * live handle holds.
 *
 *   node scripts/probe-handover.ts [chrome,firefox,safari]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';
import { browserCapabilities, WDIO_CACHE_DIR } from './browsers.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8138;
const ROUNDS = 30;

const WORKER = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
onmessage = async ({ data: { role, round, mode } }) => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('handover', { create: true });
  if (role === 'A') {
    await navigator.locks.request('handover', async () => {
      postMessage({ granted: true });
      const h = await fh.createSyncAccessHandle();
      h.write(new Uint8Array([round]), { at: 0 });
      h.flush();
      if (mode === 'idle') {
        postMessage({ holding: true });
        await new Promise(() => {});
      }
      if (mode === 'busy') {
        postMessage({ holding: true });
        const end = performance.now() + 10000;
        while (performance.now() < end) {}
      }
      if (mode === 'wasm') {
        // (func (export "spin") (loop (br 0)))
        const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,115,112,105,110,0,0,10,9,1,7,0,3,64,12,0,11,11]);
        const { instance } = await WebAssembly.instantiate(bytes);
        postMessage({ holding: true });
        instance.exports.spin();
      }
      h.close();
    });
    postMessage({ done: true });
    return;
  }
  if (role === 'names') {
    const h = await fh.createSyncAccessHandle();
    postMessage({ held: true });
    await new Promise((r) => { onmessage = r; });
    h.close();
    postMessage({ closed: true });
    return;
  }
  await navigator.locks.request('handover', async () => {
    const t0 = performance.now();
    let first = 'ok';
    for (let attempt = 0; ; attempt++) {
      try {
        const h = await fh.createSyncAccessHandle();
        h.close();
        postMessage({ done: true, first, waited: performance.now() - t0 });
        return;
      } catch (e) {
        if (attempt === 0) first = e.name;
        if (performance.now() - t0 > 15000) {
          postMessage({ done: true, first, waited: -1 });
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
const handover = async (mode) => {
  const out = [];
  const b = new Worker(url);
  for (let round = 0; round < ${ROUNDS}; round++) {
    const a = new Worker(url);
    const aGranted = next(a);
    a.postMessage({ role: 'A', round, mode });
    await aGranted;
    const aNext = next(a);
    const bDone = next(b);
    b.postMessage({ role: 'B', round });
    await aNext;
    if (mode !== 'close') {
      if (mode === 'busy' || mode === 'wasm') await new Promise((r) => setTimeout(r, 200));
      a.terminate();
    }
    out.push(await bDone);
    if (mode === 'close') a.terminate();
  }
  b.terminate();
  return out;
};
const names = async () => {
  const holder = new Worker(url);
  const held = next(holder);
  holder.postMessage({ role: 'names' });
  await held;
  const root = await navigator.storage.getDirectory();
  const out = {};
  const worker = new Worker(URL.createObjectURL(new Blob([
    'onmessage = async () => { const root = await navigator.storage.getDirectory(); const fh = await root.getFileHandle("handover"); try { const h = await fh.createSyncAccessHandle(); h.close(); postMessage("ok"); } catch (e) { postMessage(e.name); } };'
  ], { type: 'text/javascript' })));
  const answer = next(worker);
  worker.postMessage(0);
  out.createSyncAccessHandle = await answer;
  try { await root.removeEntry('handover'); out.removeEntry = 'ok'; } catch (e) { out.removeEntry = e.name; }
  const closed = next(holder);
  holder.postMessage(0);
  await closed;
  worker.terminate();
  holder.terminate();
  return out;
};
window.__probe = (async () => ({
  names: await names(),
  close: await handover('close'),
  idle: await handover('idle'),
  busy: await handover('busy'),
  wasm: await handover('wasm'),
}))();
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'probe-handover-'));
writeFileSync(join(dir, 'index.html'), PAGE);
const server = spawn(
  process.execPath,
  [join(ROOT, 'scripts/static-server.ts'), dir, String(PORT)],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1000));

type Round = { first: string; waited: number };

const capabilities = (name: string): WebdriverIO.Capabilities => {
  if (name === 'safari') return { browserName: 'safari' };
  const browser = name as 'chrome' | 'firefox';
  return {
    ...browserCapabilities(browser),
    ...(browser === 'chrome'
      ? { 'goog:chromeOptions': { args: ['--headless=new'] } }
      : { 'moz:firefoxOptions': { args: ['-headless'] } }),
  };
};

try {
  for (const name of (process.argv[2] ?? 'chrome,firefox').split(',')) {
    const browser = await remote({
      logLevel: 'error',
      cacheDir: WDIO_CACHE_DIR,
      capabilities: capabilities(name),
    });
    try {
      const version = (browser.capabilities as { browserVersion?: string })
        .browserVersion;
      await browser.url(`http://localhost:${PORT}/index.html`);
      const result = (await browser.execute(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as { names: Record<string, string> } & Record<string, Round[]>;
      const tag = `${name} ${version} on ${process.platform}`;
      console.log(
        `${tag}, names on a held file: createSyncAccessHandle ${result.names.createSyncAccessHandle}, removeEntry ${result.names.removeEntry}`,
      );
      for (const mode of ['close', 'idle', 'busy', 'wasm'] as const) {
        const rounds = result[mode] as Round[];
        const failed = rounds.filter((r) => r.first !== 'ok');
        const errs = [...new Set(failed.map((r) => r.first))].join(', ');
        const waits = failed.map((r) => r.waited).sort((x, y) => x - y);
        console.log(
          `${tag}, A ${mode}: B's first open failed ${failed.length}/${rounds.length}` +
            (failed.length
              ? ` (${errs}); free after median ${waits[Math.floor(waits.length / 2)]?.toFixed(0)} ms, p90 ${waits[Math.floor(waits.length * 0.9)]?.toFixed(0)} ms, max ${waits.at(-1)?.toFixed(0)} ms, never: ${failed.filter((r) => r.waited < 0).length}`
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
