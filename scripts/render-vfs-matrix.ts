#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_VFS,
  type PlatformFeature,
  type SQLiteBuild,
  VFS_CAPABILITIES,
  type VFSMemoryModel,
} from '../src/types.ts';

/**
 * Minimum browser version shipping each platform feature, or `null` where the
 * engine does not implement it at all.
 *
 * Sources, checked 2026-08-24 — nothing enters this map without one:
 * - `opfs` (`StorageManager.getDirectory` and
 *   `FileSystemFileHandle.createSyncAccessHandle`): MDN browser-compat-data,
 *   `api/StorageManager.json` and `api/FileSystemFileHandle.json`. Both give
 *   the same versions.
 * - `readwrite-unsafe` (the `mode` option on `createSyncAccessHandle`): same
 *   source, the `mode` sub-feature. Firefox and Safari are recorded `false`.
 *
 * This is documentation data with a shelf life. Re-check it against those
 * sources rather than trusting it a year from now.
 */
/**
 * `null` — the engine does not implement the feature.
 * `'yes'` — it does, but no source consulted gives a first supporting version.
 *   caniuse's mobile columns report the *current* version, not a floor, so a
 *   number read there would be a fabricated minimum.
 */
type Support = string | 'yes' | null;

const FEATURE_SUPPORT = {
  opfs: {
    Chrome: '86',
    Android: '109',
    Firefox: '111',
    Safari: '15.2',
    iOS: '15.2',
  },
  'readwrite-unsafe': {
    Chrome: '121',
    Android: '121',
    Firefox: null,
    Safari: null,
    iOS: null,
  },
  jspi: {
    Chrome: '137',
    Android: 'yes',
    Firefox: '153',
    Safari: '27',
    iOS: null,
  },
} as const satisfies Record<PlatformFeature, Record<string, Support>>;

/**
 * What each wa-sqlite build needs from the engine beyond plain WebAssembly.
 * `sync` and `async` (Asyncify) need nothing, which is why they are reachable
 * wherever the VFS's storage is.
 */
const BUILD_FEATURE = {
  sync: null,
  async: null,
  jspi: 'jspi',
} as const satisfies Record<SQLiteBuild, PlatformFeature | null>;

/** Desktop first, then mobile. Order is deliberate and shared by both tables. */
const BROWSERS = [
  'Chrome',
  'Firefox',
  'Safari',
  'Android',
  'iOS',
] as const;
type Browser = (typeof BROWSERS)[number];

/**
 * Column headings. Edge shares Chrome's column because MDN records it as
 * mirroring Chrome for every feature here, and caniuse gives it the same JSPI
 * version — one column rather than a duplicate that could only ever drift.
 * `Android` is Chrome for Android, which lags desktop on OPFS.
 */
const BROWSER_LABEL: Record<Browser, string> = {
  Chrome: 'Chrome / Edge',
  Firefox: 'Firefox',
  Safari: 'Safari',
  Android: 'Chrome Android',
  iOS: 'Safari iOS',
};

/** The highest of several minimum versions, or null if any is unsupported. */
/** How a single support value reads on its own. */
const versionCell = (v: Support): string =>
  v === null ? '**No**' : v === 'yes' ? 'Yes' : `${v}+`;

/**
 * The highest of several minimum versions. `null` if any feature is missing;
 * `undefined` if nothing is required; `'yes'` if supported everywhere required
 * but at least one version is unestablished, which must not be rounded down to
 * a number nobody sourced.
 */
const floorOf = (
  features: readonly PlatformFeature[],
  browser: Browser,
): Support | undefined => {
  const versions: string[] = [];
  let unestablished = false;
  for (const f of features) {
    const v = FEATURE_SUPPORT[f][browser];
    if (v === null) return null;
    if (v === 'yes') unestablished = true;
    else versions.push(v);
  }
  if (versions.length === 0) return unestablished ? 'yes' : undefined;
  if (unestablished) return 'yes';
  return versions.sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a))[0];
};

/**
 * One line per browser: from which version the VFS runs, whether it runs in
 * reduced mode, and which builds are reachable there.
 *
 * Builds matter because they carry their own engine requirement: a VFS can be
 * usable in `sync` from one version and in `jspi` only from a much later one —
 * Firefox is exactly that case.
 *
 * The `degradesWithout` distinction is the whole point of the reduced-mode
 * marker. Deriving support from `requires` alone would mark `OPFSAdaptiveVFS`
 * unsupported everywhere outside Chromium, when it works there and only loses
 * pool concurrency under a long statement.
 */
const supportFor = (
  cap: {
    requires: readonly PlatformFeature[];
    degradesWithout: readonly PlatformFeature[];
    builds: readonly SQLiteBuild[];
  },
  browser: Browser,
): string | null => {
  const base = floorOf(cap.requires, browser);
  // Absent means unsupported: a browser the VFS cannot run on is dropped from
  // the list rather than carrying a symbol the reader has to decode.
  if (base === null) return null;

  const reduced = cap.degradesWithout.some(
    (f) => FEATURE_SUPPORT[f][browser] === null,
  );
  const marker = reduced ? ' [(*)](#-reduced-mode)' : '';
  // `0` rather than a blank: the pair is always two positions, and an engine
  // with no floor at all reads as 0 instead of leaving the reader to guess
  // whether a number went missing.
  const first = base === undefined || base === 'yes' ? '0' : `${base}+`;

  // Opting into `jspi` raises the floor, sometimes by a lot — Firefox runs the
  // default build from 111 but jspi only from 153. Both numbers, or a reader
  // plans against the wrong one. Rendered `111+/153+`: the build the second
  // number belongs to is named in the Builds column of the same row, so
  // repeating "jspi" five times per line adds nothing. `?` means the engine has
  // it but no source publishes a first version; `(no jspi)` is spelled out
  // rather than left absent, because a missing half would read as an omission.
  let second = '';
  if (cap.builds.includes('jspi')) {
    const f = floorOf([...cap.requires, 'jspi'], browser);
    second =
      f === null
        ? ' (no jspi)'
        : f === undefined
          ? '/0'
          : `/${f === 'yes' ? '?' : `${f}+`}`;
  }

  return `${browser} ${first}${second}${marker}`;
};

/**
 * The build grid: rows are builds, columns are browsers. Builds live in their
 * own table because their requirement is orthogonal to the VFS's storage — a
 * VFS reachable in `sync` from one version may need a far later one for `jspi`.
 * Cramming both dimensions into one cell was unreadable.
 */
/** One sentence per build, rendered under its own heading so links can land there. */
const BUILD_NOTE: Record<SQLiteBuild, string> = {
  sync: 'Plain synchronous WebAssembly. Needs nothing beyond baseline WASM, so it runs anywhere — but only VFS whose file operations are all synchronous can offer it.',
  async:
    'Asyncify: the WASM stack is unwound and rewound around asynchronous file operations. Also needs nothing beyond baseline WASM. This is the default, and every VFS here can run on it.',
  jspi: 'JavaScript Promise Integration — the same asynchrony handled by the engine rather than by Asyncify. Opt-in, and no default uses it, so its narrower availability constrains nobody who does not ask for it.',
};

const BUILDS = Object.keys(BUILD_FEATURE) as SQLiteBuild[];

const HEADER = `| ${BROWSERS.map((b) => BROWSER_LABEL[b]).join(' | ')} |`;
const RULE = `|${BROWSERS.map(() => '---').join('|')}|`;

/**
 * One anchored section per build, each with its own single-row table.
 *
 * There is deliberately no combined builds×browsers grid: a markdown table row
 * cannot carry an anchor GitHub honours, so the VFS table's Builds column could
 * only ever link to the grid as a whole. Giving each build its own section and
 * its own row makes the link target the answer.
 */
const buildTable = BUILDS.flatMap((build) => {
  const feature = BUILD_FEATURE[build];
  const cells = BROWSERS.map((b) =>
    feature === null ? 'Any' : versionCell(FEATURE_SUPPORT[feature][b]),
  );
  // Table first: a reader following a link from the VFS table came for the
  // versions, not for the prose.
  return [
    `#### Build \`${build}\``,
    '',
    HEADER,
    RULE,
    `| ${cells.join(' | ')} |`,
    '',
    BUILD_NOTE[build],
    '',
  ];
}).join('\n');

const BEGIN =
  '<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->';
const END = '<!-- END GENERATED VFS TABLE -->';

const MEMORY_LABEL = {
  'page-cache': 'Page cache only, bounded by `PRAGMA cache_size`',
  'whole-database': '**Whole database in RAM**, multiplied by `poolSize`',
} as const satisfies Record<VFSMemoryModel, string>;

const rows = Object.entries(VFS_CAPABILITIES).map(([name, cap]) => {
  const label = name === DEFAULT_VFS ? `\`${name}\` **(default)**` : `\`${name}\``;
  const builds = cap.builds
    .map((b) => `[\`${b}\`](#build-${b})`)
    .join(', ');
  const pool =
    cap.maxPoolSize === null
      ? 'Any'
      : `**${cap.maxPoolSize}** — ${cap.poolLimitReason}`;
  const shared = cap.multiConnection ? 'Yes' : 'No';
  const durable = cap.persistent ? 'Yes' : '**No — volatile**';
  // One line: the build dimension moved to its own grid, so what is left here
  // is only the storage floor, which is short enough to read at a glance.
  // No 'Any browser' shortcut: a VFS with no storage requirement can still be
  // barred from `jspi` on an engine, and hiding that behind two words would
  // make this column mean something different from row to row.
  // One line per browser: a middot between five version pairs read as one
  // run-on string, and the numbers stopped being scannable.
  const compat = BROWSERS.map((b) => supportFor(cap, b))
    .filter((x): x is string => x !== null)
    .join('<br>');
  return `| ${label} | ${builds} | ${compat} | ${pool} | ${shared} | ${durable} | ${MEMORY_LABEL[cap.memoryModel]} |`;
});

const table = [
  '| VFS | Builds | Browser compatibility | Pool size | Shared between connections | Survives close | Memory |',
  '|-----|--------|-----------------------|-----------|----------------------------|----------------|--------|',
  ...rows,
].join('\n');

const BUILD_BEGIN =
  '<!-- BEGIN GENERATED BUILD TABLE — edit FEATURE_SUPPORT in scripts/render-vfs-matrix.ts -->';
const BUILD_END = '<!-- END GENERATED BUILD TABLE -->';

/** Replace the content between two markers, failing loudly if either is absent. */
const splice = (
  source: string,
  begin: string,
  end: string,
  body: string,
): string => {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop === -1) {
    throw new Error(
      `README markers not found (${begin.slice(0, 40)}…) — see scripts/render-vfs-matrix.ts`,
    );
  }
  if (stop < start) {
    throw new Error('README END marker precedes its BEGIN marker');
  }
  return source.slice(0, start + begin.length) + '\n\n' + body + '\n\n' + source.slice(stop);
};

const path = new URL('../README.md', import.meta.url);
let readme = readFileSync(path, 'utf8');
readme = splice(readme, BEGIN, END, table);
readme = splice(readme, BUILD_BEGIN, BUILD_END, buildTable);
writeFileSync(path, readme);

console.log(
  `Rendered ${rows.length} VFS rows and ${BUILDS.length} build sections into README.md`,
);
