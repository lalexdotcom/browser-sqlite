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
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Vitest } from 'vitest/node';
import type { Planned } from '../tests/harness/planner/guard.ts';
import { ROOT } from './parallel.ts';
import {
  driverLostLine,
  openVitest,
  type PlannedRun,
  projectNamed,
} from './plan-io.ts';

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

/** One run of the cell's specs in a fresh Vitest: whether it failed, and why if only its browser driver did. */
const runOnce = async (): Promise<{ failed: boolean; driverLost?: string }> => {
  let vitest: Vitest | undefined;
  // Set once the run is known to have lost its driver, so its close may fail.
  let closingLost = false;
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
    const tests = result.testModules.flatMap((m) => [...m.children.allTests()]);
    const collected = new Set(tests.map((t) => t.id));
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
    const driverLost = failed
      ? driverLostLine(
          [
            ...result.unhandledErrors,
            ...result.testModules.flatMap((m) => m.errors()),
          ],
          tests.filter((t) => t.result().state === 'failed').length,
        )
      : undefined;
    if (driverLost === undefined) return { failed };
    closingLost = true;
    return { failed, driverLost };
  } catch (error) {
    // A session the driver never opened can reject the run itself.
    const driverLost = driverLostLine([error], 0);
    if (driverLost === undefined) throw error;
    closingLost = true;
    console.error(error);
    return { failed: true, driverLost };
  } finally {
    // A lost session also fails its close ("invalid session id"); any other
    // close failure is the run's own and is thrown.
    await vitest?.close().catch((error: unknown) => {
      if (driverLostLine([error], 0) === undefined && !closingLost) throw error;
    });
  }
};

// A cell whose only failure is its browser driver says nothing of the
// library: it runs once more, whole, and the reports are the second run's.
// In a process of its own: a second Vitest in this one inherits the dropped
// session's server state and fails at once ("rpc is closed", measured
// 2026-11-14 by killing a cell's Chrome mid-test). Never more than once
// (BSQ_CELL_RETRY), and never when a test failed of its own (driverLostLine).
// The events file is append-only (ci-progress reads it by offset): a
// retraction withdraws what the first run reported, and a `retried` event
// says why the cell ran again, so the summary lists it as passed on retry
// rather than hiding it.
const outcome = await runOnce();
if (outcome.driverLost !== undefined && process.env.BSQ_CELL_RETRY !== '1') {
  console.warn(
    `run-cell: retrying ${cell.project} in a process of its own — ${outcome.driverLost}`,
  );
  const events = process.env.BSQ_PROGRESS_EVENTS;
  if (events) {
    appendFileSync(
      events,
      `${JSON.stringify({ retract: true })}\n${JSON.stringify({
        file: '(cell)',
        test: '(browser driver)',
        message: `cell run again: ${outcome.driverLost}`.slice(0, 300),
        retried: true,
      })}\n`,
    );
  }
  const again = spawnSync(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, BSQ_CELL_RETRY: '1' } },
  );
  process.exitCode = again.status === 0 ? 0 : 1;
} else {
  process.exitCode = outcome.failed ? 1 : 0;
}
