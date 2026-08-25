#!/usr/bin/env node
/**
 * Watch-mode dev server for the benchmark page.
 *
 * The trap this removes: `bench:serve` serves `_site`, not the sources, so an
 * edit to bench/index.html changed nothing on screen until the assembler ran
 * again — from a second terminal, because the first was held by the server.
 *
 * Two watch paths, because they do not cost the same. Editing the page needs
 * the assembler alone (~30 ms); editing the library needs a full rslib build
 * first (~600 ms). Both are cheap enough that nothing here tries to be clever
 * about which files changed beyond that split.
 *
 * There is deliberately no live reload. This page runs benchmarks; a reload
 * fired mid-run would destroy the measurement in progress and the visitor
 * would never know why. It prints when the rebuild lands, and you refresh.
 *
 * Usage: node scripts/bench-dev.mjs [port]
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.argv[2] ?? '8099';
const OUT = '_site';

const run = (command, args) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited ${code}`)),
    );
  });

const buildLibrary = () => run('pnpm', ['build']);
const assemble = () => run(process.execPath, ['scripts/bench-assemble.mjs', OUT]);

const stamp = () =>
  new Date().toLocaleTimeString('en-GB', { hour12: false });

/**
 * One rebuild at a time, with at most one queued behind it. A burst of file
 * events during a save collapses into a single rebuild, and a library change
 * arriving while a page-only rebuild runs upgrades the queued one rather than
 * being lost.
 */
let running = false;
let queued = null;
let timer;

const rebuild = async (kind) => {
  running = true;
  const started = Date.now();
  try {
    if (kind === 'full') await buildLibrary();
    await assemble();
    process.stdout.write(
      `[${stamp()}] rebuilt (${kind}) in ${Date.now() - started} ms — refresh the page\n`,
    );
  } catch (error) {
    // A broken build must not kill the watcher: fix the source and save again.
    process.stdout.write(`[${stamp()}] build failed: ${error.message}\n`);
  } finally {
    running = false;
    if (queued) {
      const next = queued;
      queued = null;
      void rebuild(next);
    }
  }
};

const request = (kind) => {
  // 'full' outranks 'page': a library change still needs the library built.
  if (running) {
    queued = queued === 'full' || kind === 'full' ? 'full' : 'page';
    return;
  }
  clearTimeout(timer);
  const next = queued === 'full' || kind === 'full' ? 'full' : 'page';
  queued = null;
  timer = setTimeout(() => void rebuild(next), 120);
};

await buildLibrary();
await assemble();

const server = spawn(
  process.execPath,
  [join(root, 'scripts/static-server.mjs'), join(root, OUT), port],
  { cwd: root, stdio: 'inherit' },
);
server.on('exit', (code) => {
  process.stdout.write(`static server exited (${code})\n`);
  process.exit(code ?? 0);
});

// Watch the directory rather than the file: editors replace a file on save
// instead of writing through it, which detaches a watch bound to the inode.
watch(join(root, 'bench'), () => request('page'));
watch(join(root, 'src'), { recursive: true }, () => request('full'));

process.stdout.write(
  `\nserving ${OUT} on http://127.0.0.1:${port}/ — watching bench/ and src/\n` +
    'http://127.0.0.1 is a secure context, so OPFS works without a certificate.\n' +
    'Ctrl-C to stop.\n\n',
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.kill();
    process.exit(0);
  });
}
