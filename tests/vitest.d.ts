import type { BrowserName } from '../scripts/browsers';
import type { PlatformFeature } from '../src/const/platform';
import type { Planned } from './harness/planner/guard';
import type { TestTarget } from './harness/target';

declare module 'vitest' {
  export interface ProvidedContext {
    bsqTarget: TestTarget;
    /** BSQ_TIME_SCALE, for the bounds a test writes itself (`scaled()`). */
    bsqTimeScale: number;
    /** The family of this project: which browser, isolated or not. */
    bsqEnvironment: { browser: BrowserName; isolated: boolean };
    /** Set by a planned cell (scripts/run-cell.ts); absent in a direct run. */
    bsqPlanned?: Planned;
  }
  export interface TaskMeta {
    /** What tests/browser/probe/features.test.ts found in its environment. */
    features?: PlatformFeature[];
    /** Under BSQ_TEST_TRACE=1: what the test touched (tests/browser/setup/trace.ts). */
    bsqTrace?: { targetReads: number; workers: number; tags: string[] };
  }
}
