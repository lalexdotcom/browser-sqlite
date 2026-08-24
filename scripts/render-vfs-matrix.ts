#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_VFS, VFS_CAPABILITIES, type VFSMemoryModel } from '../src/types.ts';

const BEGIN =
  '<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->';
const END = '<!-- END GENERATED VFS TABLE -->';

const MEMORY_LABEL = {
  'page-cache': 'Page cache only, bounded by `PRAGMA cache_size`',
  'whole-database': '**Whole database in RAM**, multiplied by `poolSize`',
} as const satisfies Record<VFSMemoryModel, string>;

const rows = Object.entries(VFS_CAPABILITIES).map(([name, cap]) => {
  const label = name === DEFAULT_VFS ? `\`${name}\` **(default)**` : `\`${name}\``;
  const builds = cap.builds.map((b) => `\`${b}\``).join(', ');
  const pool =
    cap.maxPoolSize === null
      ? 'Any'
      : `**${cap.maxPoolSize}** — ${cap.poolLimitReason}`;
  const shared = cap.multiConnection ? 'Yes' : 'No';
  const durable = cap.persistent ? 'Yes' : '**No — volatile**';
  return `| ${label} | ${builds} | ${pool} | ${shared} | ${durable} | ${MEMORY_LABEL[cap.memoryModel]} |`;
});

const table = [
  '| VFS | Builds | Pool size | Shared between connections | Survives close | Memory |',
  '|-----|--------|-----------|----------------------------|----------------|--------|',
  ...rows,
].join('\n');

const path = new URL('../README.md', import.meta.url);
const readme = readFileSync(path, 'utf8');

const start = readme.indexOf(BEGIN);
const end = readme.indexOf(END);
if (start === -1 || end === -1) {
  throw new Error('README markers not found — see scripts/render-vfs-matrix.ts');
}

const next =
  readme.slice(0, start + BEGIN.length) +
  '\n\n' +
  table +
  '\n\n' +
  readme.slice(end);

writeFileSync(path, next);
console.log(`Rendered ${rows.length} VFS rows into README.md`);
