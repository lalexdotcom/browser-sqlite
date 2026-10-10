import type { OnUnmetNeed, TestTarget } from './browser/target';

declare module 'vitest' {
  export interface ProvidedContext {
    bsqTarget: TestTarget;
    bsqNeeds: OnUnmetNeed;
  }
}
