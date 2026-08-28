#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import bcd from '@mdn/browser-compat-data' with { type: 'json' };
import {
  RECOMMENDED_VFS,
  BUILD_REQUIREMENTS,
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
  // FileSystemFileHandle.createWritable, which OPFSAnyContextVFS writes
  // through. WebKit shipped it eleven versions after OPFS itself, so this is
  // what keeps that row from claiming Safari 15.2.
  'writable-stream': {
    Chrome: '86',
    Android: '109',
    Firefox: '111',
    Safari: '26',
    iOS: '26',
  },
  // Safari 27 ships JSPI on every OS it lands on — macOS, iOS, iPadOS and
  // visionOS (webkit.org/blog/17967, "News from WWDC26: WebKit in Safari 27
  // beta", checked 2026-08-25). Corroborated: our own runs detect
  // WebAssembly.Suspending on iPadOS 27 and not on iOS Safari 26.6.
  jspi: {
    Chrome: '137',
    Android: 'yes',
    Firefox: '153',
    Safari: '27',
    iOS: '27',
  },
} as const satisfies Record<PlatformFeature, Record<string, Support>>;

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

/** How a single support value reads on its own. */
/** The later of two version strings, comparing segment by segment. */
const laterOf = (a: string, b: string): string => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? a : b;
  }
  return a;
};

/** How this script's browser keys are spelled in browser-compat-data. */
const BCD_KEY: Record<Browser, string> = {
  Chrome: 'chrome',
  Firefox: 'firefox',
  Safari: 'safari',
  Android: 'chrome_android',
  iOS: 'safari_ios',
};

/**
 * What the library itself needs in the published bundle, before any VFS is
 * considered. Named as browser-compat-data paths and READ from it, not
 * transcribed: a hand-copied floor rots behind a "checked <date>" comment that
 * nobody re-checks, and this one was already a year of drift waiting to happen.
 *
 * `MessageChannel` is what `cloneable()` in the worker probes with. It could
 * have been `structuredClone`, which is the obvious call — and which lands at
 * Chrome 98 against MessageChannel's Chrome 2. The floor of the whole library
 * would have moved six versions to protect an error *cause*.
 */
const LIB_REQUIRES: Record<string, { __compat?: { support: object } }> = {
  'Array.prototype.at': bcd.javascript.builtins.Array.at,
  'crypto.randomUUID': bcd.api.Crypto.randomUUID,
  MessageChannel: bcd.api.MessageChannel,
};

/**
 * The first version of `browser` shipping `feature`, as a plain version string.
 *
 * Throws on anything else on purpose. `true` ("supported, no version") and
 * `false` are both meaningful in browser-compat-data and neither can be folded
 * into a floor: one would invent a number, the other means the library does not
 * run there at all. Either is a table this script must not silently emit.
 */
const bcdVersion = (name: string, node: unknown, browser: Browser): string => {
  const key = BCD_KEY[browser];
  const support = (node as { __compat: { support: Record<string, unknown> } })
    .__compat.support[key];
  const entry = (Array.isArray(support) ? support[0] : support) as
    | { version_added?: unknown }
    | undefined;
  const added = entry?.version_added;
  if (typeof added !== 'string') {
    throw new Error(
      `browser-compat-data gives ${name} on ${key} as ${JSON.stringify(added)}, ` +
        'not a version. A floor cannot be computed from it — decide what the ' +
        'library claims there and say so here explicitly.',
    );
  }
  return added;
};

/**
 * The library's own floor per browser: the latest first-version among the APIs
 * it uses.
 *
 * Every VFS cell is the LATER of this and the VFS's own requirement — a VFS
 * that works where the library does not is not information a reader can use.
 */
const LIB_FLOOR: Record<string, string> = Object.fromEntries(
  BROWSERS.map((browser) => [
    browser,
    Object.entries(LIB_REQUIRES).reduce(
      (floor, [name, node]) => laterOf(floor, bcdVersion(name, node, browser)),
      '0',
    ),
  ]),
);

/** A VFS floor raised to the library's, which no VFS can go below. */
const withLibFloor = (v: Support | undefined, browser: string): Support => {
  const lib = LIB_FLOOR[browser] ?? '0';
  if (v === null) return null;
  // `yes` means supported from a version no source gives. Raising it to the
  // library's floor would invent a number: the true floor is at least that, but
  // may be higher, and only `?` says so honestly.
  if (v === 'yes') return 'yes';
  if (v === undefined) return lib;
  return laterOf(v, lib);
};

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
  const first = `${withLibFloor(base, browser)}+`;

  // Opting into `jspi` raises the floor, sometimes by a lot — Firefox runs the
  // default build from 111 but jspi only from 153. Both numbers, or a reader
  // plans against the wrong one. Rendered `111+/153+`: the build the second
  // number belongs to is named in the Builds column of the same row, so
  // repeating "jspi" five times per line adds nothing. `?` means the engine has
  // it but no source publishes a first version; `(no jspi)` is spelled out
  // rather than left absent, because a missing half would read as an omission.
  let second = '';
  if (cap.builds.includes('jspi')) {
    const f = floorOf([...cap.requires, ...BUILD_REQUIREMENTS.jspi], browser);
    const raised = withLibFloor(f, browser);
    second = raised === null ? ' (no jspi)' : `/${raised === 'yes' ? '?' : `${raised}+`}`;
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

const BUILDS = Object.keys(BUILD_REQUIREMENTS) as SQLiteBuild[];

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
  const features = BUILD_REQUIREMENTS[build];
  const cells = BROWSERS.map((b) =>
    features.length === 0 ? 'Any' : versionCell(floorOf(features, b)),
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
  const label =
    name === RECOMMENDED_VFS
      ? `\`${name}\` **(recommended)**`
      : `\`${name}\``;
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
