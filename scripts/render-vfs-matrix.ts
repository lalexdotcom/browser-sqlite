#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import bcd from '@mdn/browser-compat-data' with { type: 'json' };
import {
  BUILD_REQUIREMENTS,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type VFSCapability,
  type VFSMemoryModel,
} from '../src/types.ts';

/**
 * The VFS this project recommends when a caller has no reason to choose
 * another. It is documentation, not code: it lives in the generator so that
 * nothing shipped to a consumer carries it.
 *
 * It is NOT a default — `vfs` is required, precisely so that the name lives in
 * the consumer's own source and cannot move underneath their data. Each VFS
 * has its own store, so a recommendation that moved while it was reachable
 * from the library would displace a database rather than merely change advice.
 *
 * There are two, and they are not interchangeable: `OPFSAdaptiveVFS` defaults
 * to the `async` build and stays interruptible on every engine, while
 * `OPFSWriteAheadVFS` is faster but defaults to `sync`, which only interrupts a
 * running statement under cross-origin isolation. `README.md` states that trade
 * where it recommends them; this list only marks the rows.
 *
 * Changing it changes one marker per row of `VFS.md` and nothing else. The
 * README prose is written by hand and does not read this.
 */
const RECOMMENDED_VFS: readonly SQLiteVFS[] = [
  'OPFSWriteAheadVFS',
  'OPFSAdaptiveVFS',
];

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
  FinalizationRegistry: bcd.javascript.builtins.FinalizationRegistry,
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
  // Superscript, like the footnote calls: it hangs off the version pair rather
  // than sitting in the run of numbers, so a line of five stays scannable.
  const marker = reduced
    ? '<sup><a href="#reduced-mode">[reduced]</a></sup>'
    : '';
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
    'Asyncify: the WASM stack is unwound and rewound around asynchronous file operations. Also needs nothing beyond baseline WASM. Every VFS here can run on it.',
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
  // A build that requires no feature runs wherever the library does, so its row
  // would read `Any` in every column: the note says that in fewer characters.
  const table =
    features.length === 0
      ? []
      : [
          HEADER,
          RULE,
          `| ${BROWSERS.map((b) => versionCell(floorOf(features, b))).join(' | ')} |`,
          '',
        ];
  // Table first: a reader following a link from the VFS table came for the
  // versions, not for the prose.
  return [`### Build \`${build}\``, '', ...table, BUILD_NOTE[build], ''];
}).join('\n');

const BEGIN =
  '<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->';
const END = '<!-- END GENERATED VFS TABLE -->';

const MEMORY_LABEL = {
  'page-cache': 'Page cache only, bounded by `PRAGMA cache_size`',
  'whole-database': '**Whole database in RAM**, multiplied by `poolSize`',
} as const satisfies Record<VFSMemoryModel, string>;

/**
 * What a per-VFS header shows on its `RAM:` line. The full sentence goes to a
 * footnote instead, so the line stays scannable across nine fiches — and the
 * footnote text IS `MEMORY_LABEL`, so the short form can never say something
 * the long form does not.
 */
const MEMORY_SHORT = {
  'page-cache': 'Page cache',
  'whole-database': 'Whole database',
} as const satisfies Record<VFSMemoryModel, string>;

/**
 * Every footnote the per-VFS headers refer to, in the order they are numbered.
 *
 * Plain HTML rather than GFM footnotes: GFM renders a shared note's call sites
 * as `1`, `1:2`, `1:3` …, which is correct — the suffix is what lets its return
 * arrows find the right one — but it reads as a defect on a page where three
 * notes are shared nine, six and three times. No return link is emitted either:
 * following an in-page anchor pushes a history entry, so Back already goes
 * where the arrow would.
 *
 * The definition line is markdown, and the anchor above it is a block of its
 * own — GitHub does not parse markdown inside a block-level HTML element, so
 * wrapping these in `<ol><li>` would print the backticks literally.
 *
 * All of them are generated, `browsers` included: the numbering is positional,
 * so a hand-written note among them would renumber the rest the day it moved.
 */
const FOOTNOTES: readonly { readonly id: string; readonly text: string }[] = [
  {
    id: 'browsers',
    text:
      'Derived from documented platform support, not from our own test runs.' +
      ' These versions cover where the VFS stores its data; which builds are' +
      ' reachable on each engine is a separate question, answered under' +
      ' [Builds reference](#builds-reference) — the **Builds** line links' +
      ' straight to the build it names.',
  },
  ...Object.keys(MEMORY_SHORT).map((m) => ({
    id: `ram-${m}`,
    text: `${MEMORY_LABEL[m as VFSMemoryModel]}.`,
  })),
  ...Object.entries(VFS_CAPABILITIES)
    .filter(([, cap]) => cap.maxPoolSize !== null)
    .map(([name, cap]) => ({
      id: `pool-${name}`,
      text: `Pool size: ${cap.maxPoolSize} max — ${cap.poolLimitReason}.`,
    })),
];

/**
 * Numbering, with notes that say the same thing folded into one.
 *
 * `MemoryVFS` and `MemoryAsyncVFS` cap their pool for the same reason and so
 * carry the same sentence; printed twice under two numbers, a reader takes the
 * second for a nuance they missed. Folding is on the TEXT, not on the id, so
 * the day one of them gets its own reason it splits back apart on its own.
 */
const NOTE_TEXTS: string[] = [];
const NOTE_NUMBER = new Map<string, number>();
for (const { id, text } of FOOTNOTES) {
  const seen = NOTE_TEXTS.indexOf(text);
  if (seen === -1) NOTE_TEXTS.push(text);
  NOTE_NUMBER.set(id, (seen === -1 ? NOTE_TEXTS.length : seen + 1));
}

/** The superscript call site. Throws rather than emitting a dangling link. */
const noteRef = (id: string): string => {
  const n = NOTE_NUMBER.get(id);
  if (n === undefined) throw new Error(`no footnote declared for "${id}"`);
  return `<sup><a href="#fn-${n}">[${n}]</a></sup>`;
};

/**
 * Laid out like the GFM footnote section it replaces: a rule, then the notes in
 * small type, with no visible heading — GFM's own "Footnotes" heading is
 * `sr-only`, so a sighted reader sees the rule and nothing else.
 *
 * The muted grey is the one thing that cannot be reproduced. GitHub strips
 * `style` and custom `class` from rendered markdown, so `.footnotes { color }`
 * has no equivalent here; `<sub>` gives the size, and nothing gives the colour.
 * Inline markdown still renders inside `<sub>` because it is an inline element.
 */
const footnotes = [
  '---',
  ...NOTE_TEXTS.map(
    (text, i) => `<a id="fn-${i + 1}"></a>\n<sub>**${i + 1}.** ${text}</sub>`,
  ),
].join('\n\n');

/**
 * The header rendered under each VFS's own heading in the VFS reference.
 *
 * Same source as the table above it — `VFS_CAPABILITIES` — so the two cannot
 * disagree. Only the header is generated: the prose a reader finds below it is
 * hand-written and never touched, which is why each block carries its own
 * BEGIN/END pair rather than the section being rewritten wholesale.
 */
const detailFor = (name: string, cap: VFSCapability): string => {
  const builds = cap.builds.map((b) => `[\`${b}\`](#build-${b})`).join(', ');
  const compat = BROWSERS.map((b) => supportFor(cap, b, '(reduced)'))
    .filter((x): x is string => x !== null)
    .join(', ');
  // The cap's reason goes to a footnote of its own: it is a full sentence, it
  // differs per VFS, and inlining four of them made the fact line unreadable.
  // One reference each, so they number cleanly rather than repeating one note.
  const pool =
    cap.maxPoolSize === null
      ? cap.singleConnectionWithout.length === 0
        ? 'Any'
        : `Any, 1 without ${cap.singleConnectionWithout.map((f) => `\`${f}\``).join(', ')}`
      : `**${cap.maxPoolSize}**${noteRef(`pool-${name}`)}`;
  // No `Shared` line: an unbounded pool and sharing between connections are the
  // same fact here, because a pool worker IS a connection. They are separate
  // fields in `VFS_CAPABILITIES` and nothing in the type forces them together,
  // so this asserts rather than assumes — a VFS that ever caps its pool for a
  // reason unrelated to sharing would otherwise be described wrongly, silently.
  if ((cap.maxPoolSize === null) !== cap.multiConnection) {
    throw new Error(
      'maxPoolSize and multiConnection have diverged: the per-VFS header drops' +
        ' `Shared` because they agree. Render it again — see this guard.',
    );
  }
  const facts = [
    `**Pool size:** ${pool}`,
    `**RAM:** ${MEMORY_SHORT[cap.memoryModel]}${noteRef(`ram-${cap.memoryModel}`)}`,
  ];
  // Shown only when there are any: an empty "Default PRAGMAs: —" on six of the
  // nine VFS is a line the reader learns to skip, which costs the three that
  // do carry one.
  const pragmas = Object.entries(cap.defaultPragmas);
  if (pragmas.length) {
    facts.push(
      `**Default PRAGMAs:** ${pragmas.map(([k, v]) => `\`${k}=${v}\``).join(', ')}`,
    );
  }
  // Same rule, and the same declaration deleteDatabase reads: the files a VFS
  // keeps beside the database, beyond the -journal / -wal every one may have.
  if (cap.extraFileSuffixes.length) {
    facts.push(
      `**Extra files:** ${cap.extraFileSuffixes.map((s) => `\`${s}\``).join(', ')}`,
    );
  }
  return [
    `**Builds:** ${builds}`,
    // The footnote marker rides the label, not the versions: GFM collects one
    // definition for all nine references and backlinks each, so the caveat is
    // written once at the foot of the file. Its `[^browsers]` definition is
    // hand-written there — do not delete it, the references would render raw.
    `**Browsers:**${noteRef('browsers')} ${compat}`,
    facts.join(' · '),
  ].join('\n\n');
};

/**
 * GitHub's heading slug: lowercased, everything but letters, digits, spaces and
 * hyphens dropped, spaces to hyphens. Backticks and parentheses go, which is
 * why `### Build \`sync\`` lands on `#build-sync`.
 */
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ +/g, '-');

/**
 * Shorter labels for the contents line, where the heading itself is too long or
 * repeats its parent. Keyed on the heading, so a rename breaks the override
 * loudly — the entry stops matching and the full heading appears instead.
 */
const TOC_HEADING = 'Contents';

const TOC_LABEL: Record<string, string> = {
  'If you can guarantee a browser': 'Per browser',
};

/**
 * The contents, built from the headings actually present rather than from a
 * list kept beside them: renaming a section moves its entry, and adding a VFS
 * adds one, with nothing here to remember.
 */
const tableOfContents = (doc: string): string => {
  const lines: string[] = [];
  let current: { title: string; children: string[] } | null = null;
  const label = (h: string) =>
    TOC_LABEL[h] ?? h.replace(/`/g, '').replace(/^Build /, '');
  const flush = () => {
    if (current) lines.push(`- ${current.title}${current.children.join(' · ')}`);
  };
  for (const [, hashes, heading] of doc.matchAll(/^(#{2,3}) (.+)$/gm)) {
    // The contents heading is not one of the sections it lists.
    if (heading === TOC_HEADING) continue;
    const link = `[${label(heading)}](#${slug(heading)})`;
    if (hashes === '##') {
      flush();
      current = { title: `**${link}**: `, children: [] };
    } else current?.children.push(link);
  }
  flush();
  return lines.join('\n');
};

/**
 * The VFS that share one file per database name, for the callout in `VFS.md`.
 *
 * `layout` is not documentation data: `locks.ts` derives the storage namespace
 * from it — `opfs-path` collapses to one namespace, everything else keys on the
 * VFS name — and `worker.ts` gates its staging sweep on it. So the VFS sharing a
 * file are exactly those declaring `opfs-path`, and listing them by hand would
 * be a second copy of a fact the runtime already owns.
 *
 * Only the list is generated. The sentence around it is hand-written in
 * `VFS.md` and says nothing that depends on how many there are, so it stays
 * true whatever this returns.
 */
const sharedStoreVfs = (): string => {
  const shared = Object.entries(VFS_CAPABILITIES)
    .filter(([, cap]) => cap.layout === 'opfs-path')
    .map(([name]) => `\`${name}\``);
  const last = shared.pop();
  // Carries its own quote prefixes: the `> ` before the END marker sits inside
  // the replaced span, so the body has to put it back.
  return `\n> ${shared.join(', ')} and ${last}.\n> `;
};

const path = new URL('../VFS.md', import.meta.url);
const source = readFileSync(path, 'utf8');

/**
 * The VFS that carry a section of their own under Per-VFS notes, read off the
 * page itself: adding one makes the table link to it, removing one unlinks it,
 * with nothing here to keep in step.
 */
const documented = new Set(
  [...source.matchAll(/^### `(\w+)`$/gm)].map((m) => m[1]),
);

/**
 * The grid: one row per VFS, one tick per capability. Everything that needs a
 * sentence — browser floors, why a pool is capped, which PRAGMAs are applied —
 * lives in that VFS's own header under `## VFS reference`, so this stays
 * scannable and answers one question: what can this VFS do at all.
 */
const yes = (ok: boolean): string => (ok ? '✅' : '❌');

const rows = Object.entries(VFS_CAPABILITIES).map(([name, cap]) => {
  const named = documented.has(name)
    ? `[\`${name}\`](#${name.toLowerCase()})`
    : `\`${name}\``;
  const label = RECOMMENDED_VFS.some((v) => v === name)
    ? `${named}<br>**(recommended)**`
    : named;
  const builds = BUILDS.map((b) => yes(cap.builds.includes(b))).join(' | ');
  // `degradesWithout` is the right field, not `requires`: the question is
  // whether the VFS TAKES the mode when the engine offers it. No VFS here
  // requires it — one that did would be unusable off Chromium entirely.
  const unsafe = yes(cap.degradesWithout.includes('readwrite-unsafe'));
  return `| ${label} | ${builds} | ${yes(cap.maxPoolSize === null)} | ${yes(cap.persistent)} | ${unsafe} |`;
});

const table = [
  `| VFS | ${BUILDS.map((b) => `[\`${b}\`](#build-${b})`).join(' | ')} | Pool | Persistent | \`readwrite-unsafe\` |`,
  `|---|${BUILDS.map(() => '---').join('|')}|---|---|---|`,
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
  // A body inside a blockquote cannot be padded with blank lines: they would
  // end the quote and split one callout into two.
  gap = '\n\n',
): string => {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  if (start === -1 || stop === -1) {
    throw new Error(
      `VFS.md markers not found (${begin.slice(0, 40)}…) — see scripts/render-vfs-matrix.ts`,
    );
  }
  if (stop < start) {
    throw new Error('VFS.md END marker precedes its BEGIN marker');
  }
  return source.slice(0, start + begin.length) + gap + body + gap + source.slice(stop);
};

let doc = splice(source, BEGIN, END, table);
doc = splice(doc, BUILD_BEGIN, BUILD_END, buildTable);
for (const [name, cap] of Object.entries(VFS_CAPABILITIES)) {
  doc = splice(
    doc,
    `<!-- BEGIN GENERATED ${name} -->`,
    `<!-- END GENERATED ${name} -->`,
    detailFor(name, cap),
  );
}
doc = splice(
  doc,
  '<!-- BEGIN GENERATED FOOTNOTES — edit scripts/render-vfs-matrix.ts -->',
  '<!-- END GENERATED FOOTNOTES -->',
  footnotes,
);
doc = splice(
  doc,
  '<!-- BEGIN GENERATED SHARED VFS — edit `layout` in src/types.ts -->',
  '<!-- END GENERATED SHARED VFS -->',
  sharedStoreVfs(),
  '',
);
// Last: the headings it reads are the ones every splice above has settled.
doc = splice(
  doc,
  '<!-- BEGIN GENERATED TOC — headings are the source; run `pnpm docs:vfs` -->',
  '<!-- END GENERATED TOC -->',
  tableOfContents(doc),
);
writeFileSync(path, doc);

/**
 * `API.md` too, for one block: the VFS that share a file, which its
 * `deleteDatabase` warning used to transcribe. It has no generator of its own,
 * so this script owns that one span rather than leaving a fourth hand-written
 * copy of `layout` — the third was found by auditing links, not by a check.
 */
const apiPath = new URL('../API.md', import.meta.url);
writeFileSync(
  apiPath,
  splice(
    readFileSync(apiPath, 'utf8'),
    '<!-- BEGIN GENERATED SHARED VFS — edit `layout` in src/types.ts -->',
    '<!-- END GENERATED SHARED VFS -->',
    sharedStoreVfs(),
    '',
  ),
);

console.log(
  `Rendered ${rows.length} VFS rows, ${rows.length} VFS headers and ${BUILDS.length} build sections into VFS.md, and the shared-store list into both pages`,
);
