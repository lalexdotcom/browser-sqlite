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
  | { readonly status: 'timed-out' }
  | { readonly status: 'error'; readonly message: string };

export declare function parseMatrixReport(output: string): MatrixResult;

export declare function allPairs(): { vfs: string; build: string }[];

/** What `runBounded` resolves with — never rejects, so every outcome round-trips through here. */
export type BoundedResult = {
  readonly output: string;
  readonly timedOut: boolean;
  readonly error: (Error & { readonly code?: string }) | null;
};

export declare function runBounded(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<BoundedResult>;
