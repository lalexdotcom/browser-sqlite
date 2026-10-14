#!/usr/bin/env node
/**
 * One planned cell, or one shard of it, as one process:
 *
 *   node scripts/run-cell.ts <plan.json> <cell index> <shard> <shards> <blob> <json>
 *
 * Its own process, as every Vitest run here: each has its own WebDriver
 * session, so its own browser profile (scripts/test-parallel.ts). The cell's
 * tests are given by id, which the CLI cannot do, hence the Node API.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Vitest } from 'vitest/node';
import type { Planned } from '../tests/harness/planner/guard.ts';
import { ROOT } from './parallel.ts';
import { openVitest, type PlannedRun, projectNamed } from './plan-io.ts';

const USAGE =
  'usage: node scripts/run-cell.ts <plan.json> <cell index> <shard> <shards> <blob> <json>';
const [planFile, index, shard, shards, blob, json] = process.argv.slice(2);
if (json === undefined) throw new Error(USAGE);
const shardNumber = Number(shard);
const shardCount = Number(shards);
if (
  !Number.isInteger(shardNumber) ||
  !Number.isInteger(shardCount) ||
  shardNumber < 1 ||
  shardNumber > shardCount
) {
  throw new Error(
    `run-cell: shard "${shard}" of "${shards}" is invalid. ${USAGE}`,
  );
}
const run = JSON.parse(readFileSync(planFile as string, 'utf8')) as PlannedRun;
const cell = run.cells[Number(index)];
if (cell === undefined) throw new Error(`run-cell: no cell ${index}`);
// Files go round-robin to the shards: each shard keeps whole files.
const specs = cell.specs.filter((_, i) => i % shardCount === shardNumber - 1);

let vitest: Vitest | undefined;
try {
  vitest = await openVitest({ projects: [cell.project], blob, json });
  const project = projectNamed(vitest, cell.project);
  const planned: Planned = {
    tests: Object.fromEntries(
      specs.flatMap((s) => s.tests.map((t) => [t.id, t.name] as const)),
    ),
    features: cell.features,
    fullIsolation: run.fullIsolation,
    target: { vfs: cell.vfs, build: cell.build },
  };
  project.provide('bsqPlanned', planned);
  const result = await vitest.runTestSpecifications(
    specs.map((s) =>
      project.createSpecification(resolve(ROOT, s.file), {
        testIds: s.tests.map((t) => t.id),
      }),
    ),
  );
  // Every planned test must have been collected: an id the run never saw
  // would otherwise pass as an empty file.
  const collected = new Set(
    result.testModules
      .flatMap((m) => [...m.children.allTests()])
      .map((t) => t.id),
  );
  const missing = specs.flatMap((s) =>
    s.tests
      .filter((t) => !collected.has(t.id))
      .map((t) => `${t.name} (${s.file})`),
  );
  if (missing.length > 0) {
    console.error(
      `PLAN_MISSING: ${cell.project}: planned and never collected: ${missing.join('; ')}`,
    );
  }
  const failed =
    missing.length > 0 ||
    result.unhandledErrors.length > 0 ||
    result.testModules.some((m) => m.state() === 'failed');
  process.exitCode = failed ? 1 : 0;
} finally {
  await vitest?.close();
}
