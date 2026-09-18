import type { SQLiteVFS } from '../src/types.ts';

/**
 * The VFS this project recommends when a caller has no reason to choose
 * another. It is documentation, not code: it lives in the generator so that
 * nothing shipped to a consumer carries it.
 *
 * It is NOT a default — `vfs` is required, precisely so that the name lives in
 * the consumer's own source and cannot move underneath their data. Each VFS
 * has its own store, so a recommendation that moved while it was reachable
 * from the library would displace a database rather than merely change advice.
 *
 * There are two, and they are not interchangeable: `OPFSAdaptiveVFS` defaults
 * to the `async` build and stays interruptible on every engine, while
 * `OPFSWriteAheadVFS` is faster but defaults to `sync`, which only interrupts a
 * running statement under cross-origin isolation. `README.md` states that trade
 * where it recommends them; this list only marks the rows.
 *
 * Changing it changes one marker per row of `VFS.md` and nothing else. The
 * README prose is written by hand and does not read this.
 *
 * Also read by the browser suite, whose single-VFS tests run on both (spec
 * 2026-09-15, D8). Kept free of side effects so a browser test can import it:
 * the renderer cannot be imported, it writes VFS.md at module load.
 */
export const RECOMMENDED_VFS: readonly SQLiteVFS[] = [
  'OPFSWriteAheadVFS',
  'OPFSAdaptiveVFS',
];
