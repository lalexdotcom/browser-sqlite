import type { BrowserName } from '../scripts/browsers';
import type { PlatformFeature } from '../src/const/platform';
import type { TestTarget } from './browser/target';
import type { Planned } from './planner/guard';

declare module 'vitest' {
  export interface ProvidedContext {
    bsqTarget: TestTarget;
    /** The family of this project: which browser, isolated or not. */
    bsqEnvironment: { browser: BrowserName; isolated: boolean };
    /** Set by a planned cell (scripts/run-cell.ts); absent in a direct run. */
    bsqPlanned?: Planned;
  }
  export interface TaskMeta {
    /** What tests/probe/features.test.ts found in its environment. */
    features?: PlatformFeature[];
    /** Under BSQ_TEST_TRACE=1: what the test touched (tests/browser/trace.ts). */
    bsqTrace?: { targetReads: number; workers: number; tags: string[] };
  }
}
