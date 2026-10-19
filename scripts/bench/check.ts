#!/usr/bin/env node
import { spawn } from 'node:child_process';
/**
 * Driver for the benchmark page: proves the page still works on an engine
 * without clicking through it. pages.yaml runs it on the half of the site a
 * run builds anew; locally the merge hook runs it when scripts/bench/ moves.
 *
 * It asserts that the PAGE works, never that a VFS passes: a red cell can be a
 * correct report about this engine.
 *
 * Usage:
 *   pnpm bench:build
 *   node scripts/bench/check.ts [chrome|firefox] [--all] [--dir <path>]
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';
import {
  type BrowserBinaries,
  type BrowserName,
  browserCapabilities,
  resolveBrowsers,
  WDIO_CACHE_DIR,
} from '../browsers.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const engine = (process.argv[2] ?? 'chrome') as BrowserName;
if (engine !== 'chrome' && engine !== 'firefox') {
  process.stderr.write(
    `FAIL — unknown engine "${engine}": chrome or firefox\n`,
  );
  process.exit(1);
}
const all = process.argv.includes('--all');
/** The site to serve: `_site`, or one half of it (`_site/preview`). */
const dirFlag = process.argv.indexOf('--dir');
if (dirFlag !== -1 && !process.argv[dirFlag + 1]) {
  process.stderr.write('FAIL — --dir needs a path\n');
  process.exit(1);
}
const siteDir = resolve(
  root,
  dirFlag === -1 ? '_site' : (process.argv[dirFlag + 1] ?? ''),
);
if (!existsSync(join(siteDir, 'index.html'))) {
  process.stderr.write(`FAIL — no index.html in ${siteDir}\n`);
  process.exit(1);
}
/**
 * 8099 is what `bench:serve` and `bench:dev` use, so the default collides with
 * a page the developer is testing by hand — and this driver kills whatever
 * holds the port. `BENCH_PORT=8199 node scripts/bench/check.ts …` keeps the
 * two out of each other's way.
 */
const PORT = Number(process.env.BENCH_PORT ?? 8099);

const server = spawn(
  process.execPath,
  [resolve(root, 'scripts/static-server.ts'), siteDir, String(PORT)],
  { stdio: 'inherit' },
);

/** What the page publishes on `window.__BENCH__` for this driver. */
type BenchInfo = {
  LIB_VERSION: string;
  PAIRS: unknown[];
  IS_RELEASE: boolean;
  BUILD_REF: string;
  done: boolean;
  results: unknown;
};
type BenchWindow = Window & { __BENCH__?: BenchInfo };

/** The downloaded export, as far as this driver reads it. */
type BenchExport = {
  lib: string;
  preview?: string;
  sweep: { partial: boolean; listed: number; left: string[] };
  measurements: Record<string, Record<string, unknown>>;
};

/** A failed check of the page; `main` reports it and sets the exit code. */
class CheckFailure extends Error {}
const fail = (message: string): never => {
  throw new CheckFailure(message);
};

// The server is a TypeScript script Node strips on start; the browser can be
// up before it listens. Wait for it to answer.
const serverReady = async (): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  fail(`the static server did not answer on port ${PORT} within 10 s`);
};

/** The one finished `.json` in `dir`, once the browser has stopped writing it. */
const downloaded = (dir: string): string | undefined => {
  const files = readdirSync(dir);
  if (files.some((f) => /\.(crdownload|part|tmp)$/.test(f))) return undefined;
  return files.find((f) => f.endsWith('.json'));
};

const downloadDir = mkdtempSync(join(tmpdir(), 'bench-dl-'));
const capabilities = (binaries: BrowserBinaries): WebdriverIO.Capabilities =>
  browserCapabilities(
    engine,
    binaries,
    engine === 'chrome'
      ? {
          args: ['--headless=new'],
          prefs: {
            'download.default_directory': downloadDir,
            'download.prompt_for_download': false,
          },
        }
      : {
          args: ['-headless'],
          prefs: {
            'browser.download.folderList': 2,
            'browser.download.dir': downloadDir,
            'browser.download.useDownloadDir': true,
            'browser.helperApps.neverAsk.saveToDisk': 'application/json',
          },
        },
  );

let browser: WebdriverIO.Browser | undefined;

async function main(): Promise<void> {
  await serverReady();
  const binaries = (await resolveBrowsers([engine]))[engine];
  browser = await remote({
    logLevel: 'warn',
    cacheDir: WDIO_CACHE_DIR,
    capabilities: capabilities(binaries),
  });
  const b = browser;

  const problems: string[] = [];
  await b.sessionSubscribe({ events: ['log.entryAdded'] });
  b.on('log.entryAdded', (entry) => {
    if (entry.type === 'javascript') problems.push(`pageerror: ${entry.text}`);
    else if (entry.level === 'error')
      problems.push(`console.error: ${entry.text}`);
  });

  await b.url(`http://127.0.0.1:${PORT}/`);
  await b.waitUntil(
    () => b.execute(() => (window as BenchWindow).__BENCH__ !== undefined),
    { timeout: 30_000, interval: 100 },
  );

  const info = (await b.execute(
    () => (window as BenchWindow).__BENCH__,
  )) as BenchInfo;
  process.stdout.write(
    `${engine}: browser-sqlite ${info.LIB_VERSION}, ` +
      `${info.PAIRS.length} declared pairs\n`,
  );

  if (info.LIB_VERSION === 'unknown') {
    fail('__LIB_VERSION__ was not substituted — run pnpm bench:build first');
  }

  // The picker is collapsed by default and WebDriver will not click what it
  // cannot see.
  await b.execute(() => {
    (document.getElementById('picker') as HTMLDetailsElement).open = true;
  });

  const runnable = await b.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '#picker-list input[data-pair]:not([disabled])',
      ),
    ).map((e) => e.dataset.pair as string),
  );
  if (runnable.length === 0) fail('no runnable pair on this engine');
  process.stdout.write(`runnable: ${runnable.join(', ')}\n`);

  if (all) {
    await b.$('#select-all').click();
  } else {
    await b.$('#select-none').click();
    const first = await b.$(`#picker-list input[data-pair="${runnable[0]}"]`);
    if (!(await first.isSelected())) await first.click();
  }

  const summary = await b.$('#picker-summary').getText();
  process.stdout.write(`summary: ${summary}\n`);
  if (all) {
    if (!summary.startsWith('All ('))
      fail(`bad summary after select-all: ${summary}`);
  } else {
    if (!summary.startsWith('1 selected'))
      fail(`bad summary after select-one: ${summary}`);
  }

  if (problems.length) fail(problems.join('\n'));

  await b.$('#start').click();
  await b.waitUntil(
    () => b.execute(() => (window as BenchWindow).__BENCH__?.done === true),
    { timeout: 10 * 60_000, interval: 500 },
  );

  const stuck = await b.execute(
    () =>
      Array.from(document.querySelectorAll('#results td')).filter(
        (td) => td.textContent === '…',
      ).length,
  );
  if (stuck > 0) fail(`${stuck} cells never resolved`);

  const columns = await b.execute(
    () => document.querySelectorAll('#head-row th').length - 1,
  );
  if (columns === 0) fail('no column was rendered');

  const enabled = await b.execute(
    () => !(document.getElementById('download') as HTMLButtonElement).disabled,
  );
  if (!enabled) fail('download button never enabled');

  // The browser saves into `downloadDir` on its own; headless needs no display.
  await b.$('#download').click();
  await b.waitUntil(async () => downloaded(downloadDir) !== undefined, {
    timeout: 30_000,
    interval: 200,
    timeoutMsg: 'the export never landed in the download directory',
  });
  const filename = downloaded(downloadDir) as string;
  process.stdout.write(`download filename: ${filename}\n`);
  // Timestamp first: the exports are read as an ordered campaign, so the
  // directory has to sort chronologically without help.
  if (
    !/^browser-sqlite-\d{14}-\w[\w.-]*-\w[\w.-]*-[\w.-]+-[\w.-]+\.json$/.test(
      filename,
    )
  ) {
    fail(`download filename has wrong shape: ${filename}`);
  }

  const payload: BenchExport = JSON.parse(
    readFileSync(join(downloadDir, filename), 'utf8'),
  );

  const EXPECTED_KEYS = [
    'generatedAt',
    'lib',
    'agent',
    'features',
    'clockMs',
    'sweep',
    'opfsRootAtStart',
    'poolSize',
    'longQueryIterations',
    'longQueryCalibration',
    'conformance',
    'measurements',
    'reasons',
  ];
  for (const k of EXPECTED_KEYS) {
    if (!(k in payload)) fail(`export missing key: ${k}`);
  }
  if (payload.lib === 'unknown') fail('export lib is "unknown"');

  // `preview` is the one optional key, and its absence is what carries the
  // meaning: `lib` alone cannot tell a preview build from the release, since
  // both read package.json. So assert the equivalence, not the presence.
  if ('preview' in payload === info.IS_RELEASE) {
    fail(
      `preview ${'preview' in payload ? 'present' : 'absent'} on a ` +
        `${info.IS_RELEASE ? 'release' : 'development'} build`,
    );
  }
  if (!info.IS_RELEASE && payload.preview !== info.BUILD_REF) {
    fail(`preview "${payload.preview}" != build ref "${info.BUILD_REF}"`);
  }

  // A page that swept nothing measures a floor it did not establish. Not a
  // failure of the page — but on this engine, in this container, it is
  // unexpected enough to be worth printing rather than discovering later in
  // an export nobody re-reads.
  if (payload.sweep.partial) {
    process.stdout.write(
      `sweep PARTIAL — listed: ${payload.sweep.listed}, ` +
        `left: ${payload.sweep.left.join(', ') || '(none named)'}\n`,
    );
  }

  // The page and the export must not disagree about the floor: a partial sweep
  // that only the JSON knows about is the silent case this note exists to end.
  const noteShown = await b.execute(
    () => !(document.getElementById('sweep-note') as HTMLElement).hidden,
  );
  if (noteShown !== payload.sweep.partial) {
    fail(
      `sweep note ${noteShown ? 'shown' : 'hidden'} but export says ` +
        `partial: ${payload.sweep.partial}`,
    );
  }

  if (Object.keys(payload.measurements).length === 0) {
    fail('export measurements is empty — no pairs ran');
  }
  for (const [pairId, rows] of Object.entries(payload.measurements)) {
    if (Object.keys(rows).length === 0) {
      fail(`measurements[${pairId}] has no row entries`);
    }
    const internal = Object.keys(rows).filter((k) => k.startsWith('__'));
    if (internal.length > 0) {
      fail(`measurements[${pairId}] has internal keys: ${internal.join(', ')}`);
    }
  }
  process.stdout.write(
    `export OK — keys: ${Object.keys(payload).join(', ')}\n`,
  );

  process.stdout.write(
    `${columns} columns, results:\n` +
      JSON.stringify(
        await b.execute(() => (window as BenchWindow).__BENCH__?.results),
        null,
        2,
      ) +
      '\n',
  );

  process.stdout.write('OK\n');
}

try {
  await main();
} catch (error) {
  const message = error instanceof CheckFailure ? error.message : String(error);
  process.stderr.write(`FAIL — ${message}\n`);
  process.exitCode = 1;
} finally {
  await browser?.deleteSession().catch(() => {});
  rmSync(downloadDir, { recursive: true, force: true });
  server.kill();
  // An install the leader's bound abandoned keeps its download open and the process alive.
  process.exit(process.exitCode ?? 0);
}
