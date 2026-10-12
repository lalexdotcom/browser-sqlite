import type { BrowserName } from '../../scripts/browsers.ts';
import { defaultBuildFor } from '../../src/capabilities';
import type { SQLiteBuild } from '../../src/const/builds';
import type { PlatformFeature } from '../../src/const/platform';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import {
  canonicalPairs,
  needFromTags,
  representative,
  runsIn,
  shouldTestRun,
  type TestContext,
  type TestNeed,
} from '../need';

/**
 * Which cell runs which test (spec 2026-10-12, § 4). Pure: the orchestrator
 * feeds it what Vitest parsed and what the probes found, and runs what it
 * returns; the unit tests feed it by hand.
 */

export type Family = {
  readonly browser: BrowserName;
  readonly isolated: boolean;
};

/** A family's prefix in the project names of vitest.config.ts. */
export const familyName = ({ browser, isolated }: Family): string =>
  `${isolated ? 'isolated ' : ''}${browser}`;

export type Pair = { readonly vfs: SQLiteVFS; readonly build: SQLiteBuild };

/** The browser project vitest.config.ts declares for this pair in this family. */
export const projectName = (family: Family, { vfs, build }: Pair): string =>
  `${familyName(family)} · ${vfs}/${build}`;

/** One test as its family's reference parse saw it. */
export type CollectedTest = {
  readonly file: string;
  /** Index among the file's tests in declaration order: what finds the test again in another project. */
  readonly position: number;
  readonly name: string;
  readonly tags: readonly string[];
  /** The parser could not read its name: its runtime id is not knowable in advance. */
  readonly dynamic: boolean;
};

export type FamilyInput = Family & {
  readonly features: readonly PlatformFeature[];
  readonly tests: readonly CollectedTest[];
};

export type PlanOptions = {
  readonly mode: 'complement' | 'all-pairs';
  /** Isolated contexts run every eligible test, not only those isolation makes eligible (a mode asked for explicitly). */
  readonly fullIsolation: boolean;
  /** Complement mode: the start contexts' VFS, each on its default build here. */
  readonly recommended: readonly SQLiteVFS[];
  /** `BSQ_TEST_TARGETS` or `--pair`: the start pairs (complement) or the only pairs (all-pairs); never substituted. */
  readonly pairs: readonly Pair[] | 'all' | null;
};

export type CellTest = Pick<CollectedTest, 'file' | 'position' | 'name'>;

export type Cell = Family &
  Pair & {
    readonly project: string;
    readonly reason: 'start' | 'complement' | 'pair';
    readonly tests: readonly CellTest[];
  };

export type Unplaced = Family & Pick<CollectedTest, 'file' | 'name' | 'tags'>;

export type Plan = {
  readonly cells: readonly Cell[];
  /** The situation the test needs does not exist on this browser (env-capped-pool on Chrome): listed, never a failure. */
  readonly notApplicable: readonly Unplaced[];
  /** Placed in no cell of any family it belongs to. */
  readonly dead: readonly Pick<CollectedTest, 'file' | 'name' | 'tags'>[];
  /** An explicit pair a family cannot run: shown, never replaced. */
  readonly notRunnable: readonly (Family & Pair)[];
};

const pairKey = ({ vfs, build }: Pair) => `${vfs}/${build}`;

const uniquePairs = (pairs: readonly Pair[]): Pair[] => [
  ...new Map(pairs.map((pair) => [pairKey(pair), pair])).values(),
];

const assertDeclared = (pair: Pair): void => {
  const declared = VFS_CAPABILITIES[pair.vfs]?.builds as
    | readonly SQLiteBuild[]
    | undefined;
  if (!declared?.includes(pair.build)) {
    throw new Error(
      `PLAN_PAIR: ${pairKey(pair)} is not a declared vfs/build pair (VFS_CAPABILITIES)`,
    );
  }
};

export const plan = (
  families: readonly FamilyInput[],
  options: PlanOptions,
): Plan => {
  if (Array.isArray(options.pairs)) options.pairs.forEach(assertDeclared);
  // Dead and not-applicable mean something only when every pair was a candidate.
  const complete =
    options.mode === 'complement' || !Array.isArray(options.pairs);
  const cells = new Map<
    string,
    Family &
      Pair & { project: string; reason: Cell['reason']; tests: CellTest[] }
  >();
  const notApplicable: Unplaced[] = [];
  const notRunnable: (Family & Pair)[] = [];
  // `placed`: the test is in a cell of some family (or, all-pairs, a standalone one left out on purpose).
  const seen = new Map<string, { test: CollectedTest; placed: boolean }>();

  for (const family of families) {
    const features = new Set(family.features);
    const context = (pair: Pair): TestContext => ({
      ...pair,
      browser: family.browser,
      isolated: family.isolated,
      features,
    });
    const canonical: Pair[] = canonicalPairs(
      family.browser,
      family.isolated,
      features,
    ).map(({ vfs, build }) => ({ vfs, build }));
    const explicit = Array.isArray(options.pairs)
      ? options.pairs.filter((pair) => {
          if (runsIn(context(pair))) return true;
          notRunnable.push({ ...family, ...pair });
          return false;
        })
      : null;
    const starts: Pair[] =
      explicit ??
      (options.mode === 'all-pairs' || options.pairs === 'all'
        ? canonical
        : uniquePairs(
            options.recommended.map((vfs) => ({
              vfs,
              build: defaultBuildFor(vfs, features),
            })),
          ).filter((pair) => runsIn(context(pair))));
    const runs = (pair: Pair, need: TestNeed) =>
      shouldTestRun(context(pair), need, {
        dedupeIsolation: !options.fullIsolation,
      });
    const add = (pair: Pair, reason: Cell['reason'], test: CollectedTest) => {
      const project = projectName(family, pair);
      let cell = cells.get(project);
      if (cell === undefined) {
        cell = { ...family, ...pair, project, reason, tests: [] };
        cells.set(project, cell);
      }
      cell.tests.push({
        file: test.file,
        position: test.position,
        name: test.name,
      });
    };

    for (const test of family.tests) {
      if (test.dynamic) {
        throw new Error(
          `PLAN_DYNAMIC: "${test.name}" (${test.file}) is declared dynamically, so its id is unknown before it runs — declare it with a literal name`,
        );
      }
      const key = `${test.file}#${test.position}`;
      const entry = seen.get(key) ?? { test, placed: false };
      seen.set(key, entry);
      const { standalone, need } = needFromTags(test.tags);
      let placed = false;
      if (standalone) {
        // Once per browser, non-isolated, outside the matrix (spec § 3).
        // All-pairs leaves it out on purpose (never dead); an isolated family
        // never hosts it, so it is placed only by a non-isolated family.
        if (options.mode === 'all-pairs') entry.placed = true;
        if (options.mode === 'all-pairs' || family.isolated) continue;
        const host = starts[0] ?? canonical[0];
        if (host && representative(need, family.browser, features)) {
          add(host, starts[0] ? 'start' : 'complement', test);
          placed = true;
        }
      } else if (options.mode === 'all-pairs') {
        for (const pair of starts) {
          if (runs(pair, need)) {
            add(pair, 'pair', test);
            placed = true;
          }
        }
      } else {
        for (const pair of starts) {
          if (runs(pair, need)) {
            add(pair, 'start', test);
            placed = true;
          }
        }
        if (!placed) {
          const first = canonical.find((pair) => runs(pair, need));
          if (first) {
            add(first, 'complement', test);
            placed = true;
          }
        }
      }
      // Eligible on some pair of this family, dedupe aside: when it is not, the
      // situation the test needs does not exist here. A test merely deduped
      // out of an isolated family is not "not applicable" (it is dead if no
      // family places it).
      const exists =
        placed ||
        (!standalone &&
          canonical.some((pair) =>
            shouldTestRun(context(pair), need, { dedupeIsolation: false }),
          ));
      if (placed) entry.placed = true;
      else if (complete && !exists) {
        notApplicable.push({
          ...family,
          file: test.file,
          name: test.name,
          tags: test.tags,
        });
      }
    }
  }

  const dead = complete
    ? [...seen.values()]
        .filter(({ placed }) => !placed)
        .map(({ test: { file, name, tags } }) => ({ file, name, tags }))
    : [];
  // A test not applicable on one browser and placed on the other is reported
  // there; one placed nowhere is dead, and listed once, as dead.
  const deadKeys = new Set(dead.map(({ file, name }) => `${file}#${name}`));
  return {
    cells: [...cells.values()].map((cell) => ({
      ...cell,
      tests: [...cell.tests].sort((a, b) =>
        a.file === b.file ? a.position - b.position : a.file < b.file ? -1 : 1,
      ),
    })),
    notApplicable: notApplicable.filter(
      ({ file, name }) => !deadKeys.has(`${file}#${name}`),
    ),
    dead,
    notRunnable,
  };
};
