#!/usr/bin/env node
/**
 * Hand-run driver for bench/index.html. NOTHING RUNS THIS AUTOMATICALLY — it
 * is not wired into CI and must not be. It exists so a developer can prove the
 * page still works on both engines without clicking through it.
 *
 * It asserts that the PAGE works, never that a VFS passes: a red cell can be a
 * correct report about this engine.
 *
 * Usage:
 *   pnpm bench:build
 *   node scripts/bench-check.mjs [chromium|firefox] [--all]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import playwright from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = process.argv[2] ?? 'chromium';
const all = process.argv.includes('--all');
const PORT = 8099;

const server = spawn(
  process.execPath,
  [resolve(root, 'scripts/static-server.mjs'), resolve(root, '_site'), String(PORT)],
  { stdio: 'inherit' },
);

const fail = (message) => {
  process.stderr.write(`FAIL — ${message}\n`);
  server.kill();
  process.exit(1);
};

try {
  const browser = await playwright[engine].launch();
  const page = await browser.newPage();

  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__BENCH__ !== undefined, {
    timeout: 30_000,
  });

  const info = await page.evaluate(() => window.__BENCH__);
  process.stdout.write(
    `${engine}: browser-sqlite ${info.LIB_VERSION}, ` +
      `${info.PAIRS.length} declared pairs\n`,
  );

  if (info.LIB_VERSION === 'unknown') {
    fail('__LIB_VERSION__ was not substituted — run pnpm bench:build first');
  }

  const runnable = await page.$$eval(
    '#picker-list input[data-pair]:not([disabled])',
    (els) => els.map((e) => e.dataset.pair),
  );
  if (runnable.length === 0) fail('no runnable pair on this engine');
  process.stdout.write(`runnable: ${runnable.join(', ')}\n`);

  if (all) {
    await page.click('#select-all');
  } else {
    await page.click('#select-none');
    await page.check(`#picker-list input[data-pair="${runnable[0]}"]`);
  }

  const summary = await page.textContent('#picker-summary');
  if (!summary || summary === 'None selected') fail(`bad summary: ${summary}`);
  process.stdout.write(`summary: ${summary}\n`);

  if (problems.length) fail(problems.join('\n'));

  await browser.close();
  process.stdout.write('OK\n');
} finally {
  server.kill();
}
