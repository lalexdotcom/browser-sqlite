/**
 * THROWAWAY (ci/windows-macos): times each OPFS primitive in a worker, in
 * Chrome and Firefox, to find where Firefox on Windows spends its seconds.
 *
 *   node scripts/probe-opfs.ts [chrome,firefox]
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
const PORT = 8137;

const WORKER = `
const t = () => performance.now();
const ops = {};
const add = (k, v) => (ops[k] ??= []).push(v);
onmessage = async () => {
  try {
    let a = t(); const root = await navigator.storage.getDirectory(); add('getDirectory', t() - a);
    const buf = new Uint8Array(4096);
    for (let i = 0; i < 10; i++) {
      const name = 'probe-' + i;
      a = t(); const fh = await root.getFileHandle(name, { create: true }); add('getFileHandle(create)', t() - a);
      a = t(); const h = await fh.createSyncAccessHandle(); add('createSyncAccessHandle(new)', t() - a);
      a = t(); h.write(buf, { at: 0 }); add('write 4 KiB', t() - a);
      a = t(); h.flush(); add('flush', t() - a);
      a = t(); h.read(buf, { at: 0 }); add('read 4 KiB', t() - a);
      a = t(); h.getSize(); add('getSize', t() - a);
      a = t(); h.close(); add('close', t() - a);
      a = t(); const h2 = await fh.createSyncAccessHandle(); add('createSyncAccessHandle(existing)', t() - a);
      a = t(); h2.close(); add('close(2)', t() - a);
      a = t(); await root.removeEntry(name); add('removeEntry', t() - a);
    }
    a = t(); const d = await root.getDirectoryHandle('probe-dir', { create: true }); add('getDirectoryHandle(create)', t() - a);
    a = t(); await root.removeEntry('probe-dir', { recursive: true }); add('removeEntry(dir)', t() - a);
    a = t(); const wf = await (await root.getFileHandle('probe-w', { create: true })).createWritable(); await wf.write(buf); await wf.close(); add('createWritable+write+close', t() - a);
    await root.removeEntry('probe-w');
    postMessage({ ops });
  } catch (e) { postMessage({ error: String(e) }); }
};`;

const PAGE = `<!doctype html><script>
window.__probe = new Promise((resolve) => {
  const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: 'text/javascript' })));
  w.onmessage = (e) => resolve(e.data);
  w.postMessage(0);
});
</script>`;

const dir = mkdtempSync(join(tmpdir(), 'probe-opfs-'));
writeFileSync(join(dir, 'index.html'), PAGE);
const server = spawn(
  process.execPath,
  [join(ROOT, 'scripts/static-server.ts'), dir, String(PORT)],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1000));

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

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
      )) as { ops?: Record<string, number[]>; error?: string };
      console.log(`\n${name} on ${process.platform}`);
      if (result.error) console.log(`  ERROR ${result.error}`);
      for (const [op, xs] of Object.entries(result.ops ?? {})) {
        console.log(
          `  ${op.padEnd(34)} median ${median(xs).toFixed(1).padStart(8)} ms  max ${Math.max(
            ...xs,
          )
            .toFixed(1)
            .padStart(8)} ms  (n=${xs.length})`,
        );
      }
    } finally {
      await browser.deleteSession();
    }
  }
} finally {
  server.kill();
}
