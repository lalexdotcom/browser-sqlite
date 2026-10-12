import { relative, resolve } from 'node:path';
import {
  createVitest,
  experimental_getRunnerTask,
  type TestProject,
  type Vitest,
} from 'vitest/node';
import type { PlatformFeature } from '../src/const/platform.ts';
import type { Cell, CollectedTest, Family } from '../tests/planner/plan.ts';
import { ROOT } from './parallel.ts';

/**
 * The planner's side of Vitest's Node API (spec 2026-10-12, § 4; measured
 * in mem:measurements/suite-and-matrix § TEST-IDS). A plain `node` script
 * cannot import tests/planner/plan.ts — its src/ imports carry no
 * extension — so the planner is loaded through Vite (`loadPlanner`).
 */

export async function openVitest({
  projects,
  blob,
  json,
}: {
  readonly projects?: readonly string[];
  readonly blob?: string;
  readonly json?: string;
} = {}): Promise<Vitest> {
  // Every pair's projects exist, whatever the caller asked for: the plan
  // picks among them (vitest.config.ts reads this when it loads).
  process.env.BSQ_TEST_TARGETS = 'all';
  process.env.BSQ_TEST_BUILT = '1';
  const reporters = [...(blob ? ['blob'] : []), ...(json ? ['json'] : [])];
  const vitest = await createVitest('test', {
    config: resolve(ROOT, 'vitest.config.ts'),
    configLoader: 'runner',
    watch: false,
    reporters,
    ...(projects ? { project: [...projects] } : {}),
    ...(blob || json
      ? {
          outputFile: {
            ...(blob ? { blob } : {}),
            ...(json ? { json } : {}),
          },
        }
      : {}),
  });
  // Without it the reporters are never initialised: the blob reporter then
  // throws at the end of the run (measured 2026-10-12). Only for a run that
  // reports: it also starts one WebDriver per browser project in scope (94
  // drivers, 28 s, and the process then never exits), which the planning
  // phase, with every project open, must not pay.
  if (reporters.length > 0) await vitest.standalone();
  return vitest;
}

export const projectNamed = (vitest: Vitest, name: string): TestProject => {
  const project = vitest.projects.find((p) => p.name === name);
  if (project === undefined) {
    throw new Error(
      `PLAN_PROJECT: vitest.config.ts declares no project "${name}"`,
    );
  }
  return project;
};

export const loadPlanner = (vitest: Vitest) =>
  projectNamed(vitest, 'unit').import<
    typeof import('../tests/planner/plan.ts')
  >(resolve(ROOT, 'tests/planner/plan.ts'));

/** The family's probe project's view of its environment (tests/probe/features.test.ts). */
export async function probeFeatures(
  vitest: Vitest,
  family: Family,
): Promise<PlatformFeature[]> {
  const name = `probe ${family.isolated ? 'isolated ' : ''}${family.browser}`;
  const project = projectNamed(vitest, name);
  const result = await vitest.runTestSpecifications([
    project.createSpecification(resolve(ROOT, 'tests/probe/features.test.ts')),
  ]);
  const [test] = result.testModules.flatMap((m) => [...m.children.allTests()]);
  const features = test?.meta().features;
  if (!Array.isArray(features)) {
    throw new Error(
      `PLAN_PROBE: ${name} reported no features (${test?.result().state ?? 'no test'})`,
    );
  }
  return features;
}

/** Any project of the family: they share their files and how they parse. */
const referenceProject = (vitest: Vitest, family: Family): TestProject => {
  const prefix = `${family.isolated ? 'isolated ' : ''}${family.browser} · `;
  const project = vitest.projects.find((p) => p.name.startsWith(prefix));
  if (project === undefined) {
    throw new Error(`PLAN_PROJECT: no "${prefix}…" project`);
  }
  return project;
};

/** Every test of the family's files (or of `files`), with its tags, by static parsing. */
export async function collectFamily(
  vitest: Vitest,
  family: Family,
  files: readonly string[] | null,
): Promise<CollectedTest[]> {
  const project = referenceProject(vitest, family);
  const wanted = files?.map((file) => resolve(ROOT, file));
  const testFiles = (await project.globTestFiles()).testFiles.filter(
    (file) => wanted === undefined || wanted.includes(file),
  );
  const modules = await vitest.parseSpecifications(
    testFiles.map((file) => project.createSpecification(file)),
  );
  return modules.flatMap((module) =>
    [...module.children.allTests()].map((test, position) => ({
      file: relative(ROOT, module.moduleId),
      position,
      name: test.fullName,
      tags: [...test.tags],
      dynamic:
        experimental_getRunnerTask(test).dynamic === true ||
        test.id.endsWith('-dynamic'),
    })),
  );
}

export type CellSpec = {
  readonly file: string;
  readonly tests: readonly { readonly id: string; readonly name: string }[];
};

/**
 * The cell's tests as ids of the cell's own project: ids hash the project
 * name, so they are parsed there, and found by position, name checked.
 */
export async function cellSpecs(
  vitest: Vitest,
  cell: Cell,
): Promise<CellSpec[]> {
  const project = projectNamed(vitest, cell.project);
  const files = [...new Set(cell.tests.map((t) => t.file))];
  const modules = await vitest.parseSpecifications(
    files.map((file) => project.createSpecification(resolve(ROOT, file))),
  );
  return files.map((file) => {
    const module = modules.find((m) => m.moduleId === resolve(ROOT, file));
    const parsed = module ? [...module.children.allTests()] : [];
    return {
      file,
      tests: cell.tests
        .filter((t) => t.file === file)
        .map((t) => {
          const test = parsed[t.position];
          if (test === undefined || test.fullName !== t.name) {
            throw new Error(
              `PLAN_ID: ${cell.project} parses "${test?.fullName}" at position ${t.position} of ${file}, the plan has "${t.name}"`,
            );
          }
          return { id: test.id, name: test.fullName };
        }),
    };
  });
}

export type PlannedCell = Pick<Cell, 'project' | 'vfs' | 'build'> & {
  readonly features: readonly PlatformFeature[];
  readonly specs: readonly CellSpec[];
};

export type PlannedRun = {
  readonly fullIsolation: boolean;
  readonly cells: readonly PlannedCell[];
};
