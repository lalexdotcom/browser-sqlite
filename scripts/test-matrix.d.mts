/**
 * Type declarations for `test-matrix.mjs`, kept separate because the script
 * itself is plain Node ESM (see the file's own header) while
 * `tests/unit/test-matrix.test.ts` type-checks under `tsc --noEmit`.
 */

export type MatrixResult =
  | {
      readonly status: 'passed' | 'failed';
      readonly tests: number;
      readonly passed: number;
      readonly failed: number;
      readonly skipped: number;
      readonly seconds: number;
    }
  | { readonly status: 'not-runnable'; readonly seconds: number }
  | { readonly status: 'timed-out' };

export declare function parseMatrixReport(output: string): MatrixResult;

export declare function allPairs(): { vfs: string; build: string }[];
