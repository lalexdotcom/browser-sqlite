import { SQLiteError } from './types/errors';

/**
 * What closed a savepoint, carried as the `cause` of `SAVEPOINT_CLOSED`: the
 * operation, and the savepoint it addressed — this one, or one it was nested in.
 */
export type SavepointClosure = {
  readonly by: 'release' | 'rollback';
  readonly savepoint: string;
};

/** One savepoint of a transaction, as the library's copy of SQLite's stack sees it. */
export type SavepointEntry = {
  readonly name: string;
  state: 'open' | 'released' | 'rolled-back';
  closedBy?: SavepointClosure;
};

/** `send`: the operation has SQL to run. `noop`: what it promises is already true. */
export type SavepointStep = 'send' | 'noop';

/** Prefix of every name the library generates, refused in a consumer's. */
const RESERVED_PREFIX = '__bsq_';

/**
 * SQLite compares savepoint names ignoring ASCII case. `toLowerCase()` folds
 * more than ASCII, so it can only refuse a name SQLite would accept, never
 * accept one SQLite would confuse with an open savepoint.
 */
const keyOf = (name: string) => name.toLowerCase();

const invalid = (message: string) =>
  new SQLiteError('INVALID_IDENTIFIER', message);

/**
 * The library's copy of one transaction's savepoint stack (spec 2026-10-04,
 * § 5). Updated at the call, in the order the transaction's queue will run
 * the statements, so it is the order SQLite sees.
 */
export const createSavepointStack = () => {
  /** Open savepoints, outermost first. */
  const stack: SavepointEntry[] = [];
  let generated = 0;

  const open = (name?: unknown): SavepointEntry => {
    let chosen: string;
    if (name === undefined) {
      generated += 1;
      chosen = `${RESERVED_PREFIX}sp_${generated}`;
    } else {
      if (typeof name !== 'string' || name === '')
        throw invalid('A savepoint name must be a non-empty string.');
      if (name.includes('\0'))
        throw invalid(
          `A savepoint name cannot contain a NUL character: ${JSON.stringify(name)}`,
        );
      if (keyOf(name).startsWith(RESERVED_PREFIX))
        throw invalid(
          `Savepoint names starting with "${RESERVED_PREFIX}" are reserved for the library: ${JSON.stringify(name)}`,
        );
      const clash = stack.find((entry) => keyOf(entry.name) === keyOf(name));
      if (clash)
        throw invalid(
          `A savepoint named ${JSON.stringify(clash.name)} is already open; SQLite would address the newer one.`,
        );
      chosen = name;
    }
    const entry: SavepointEntry = { name: chosen, state: 'open' };
    stack.push(entry);
    return entry;
  };

  /** Pops `stack[index]` and everything above it, recording what closed them. */
  const close = (
    index: number,
    state: 'released' | 'rolled-back',
    closure: SavepointClosure,
  ) => {
    for (const entry of stack.splice(index)) {
      entry.state = state;
      entry.closedBy = closure;
    }
  };

  const closedError = (
    entry: SavepointEntry,
    attempted: 'released' | 'rolled back',
  ) => {
    const how = entry.state === 'released' ? 'released' : 'rolled back';
    const by =
      entry.closedBy && entry.closedBy.savepoint !== entry.name
        ? ` along with ${JSON.stringify(entry.closedBy.savepoint)}`
        : '';
    return new SQLiteError(
      'SAVEPOINT_CLOSED',
      `Savepoint ${JSON.stringify(entry.name)} was already ${how}${by}; it cannot be ${attempted}.`,
      { cause: entry.closedBy },
    );
  };

  const release = (entry: SavepointEntry): SavepointStep => {
    if (entry.state === 'released') return 'noop';
    if (entry.state === 'rolled-back') throw closedError(entry, 'released');
    close(stack.indexOf(entry), 'released', {
      by: 'release',
      savepoint: entry.name,
    });
    return 'send';
  };

  const rollback = (entry: SavepointEntry, release: boolean): SavepointStep => {
    // `release: false` promises an open savepoint, which a closed one is not.
    if (entry.state === 'rolled-back') {
      if (release) return 'noop';
      throw closedError(entry, 'rolled back');
    }
    if (entry.state === 'released') throw closedError(entry, 'rolled back');
    const index = stack.indexOf(entry);
    const closure: SavepointClosure = {
      by: 'rollback',
      savepoint: entry.name,
    };
    // ROLLBACK TO pops what was opened after this savepoint and keeps it.
    close(index + 1, 'rolled-back', closure);
    if (release) close(index, 'rolled-back', closure);
    return 'send';
  };

  return { open, release, rollback };
};

export type SavepointStack = ReturnType<typeof createSavepointStack>;
