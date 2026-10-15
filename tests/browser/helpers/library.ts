/**
 * `browser-sqlite` as the browser tests import it (the alias in
 * tests/vitest.config.ts): the build, unchanged — except that where
 * BSQ_TIME_SCALE is above 1, a client gets the library's default open timeout
 * (30 s) stretched by the factor, unless the test sets its own. Firefox on
 * Windows can take longer than 30 s to open an OPFS database under the
 * suite's parallel load (every file operation pays fsyncs, Mozilla bug
 * 2072928); for these tests the open timeout is a budget, not the subject. A
 * test about the open timeout passes `openTimeout` itself.
 */
import { inject } from 'vitest';
import * as library from '../../build/index.js';

export * from '../../build/index.js';

const TIME_SCALE = inject('bsqTimeScale') ?? 1;
const OPEN_TIMEOUT_MS = 30_000;

export const createSQLiteClient: typeof library.createSQLiteClient =
  TIME_SCALE === 1
    ? library.createSQLiteClient
    : (file, clientOptions) =>
        library.createSQLiteClient(file, {
          openTimeout: OPEN_TIMEOUT_MS * TIME_SCALE,
          ...clientOptions,
        });
