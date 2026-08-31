import type {
  Schema,
  SQLiteBulkWriteOptions,
  SQLiteOutputOptions,
  SQLiteOutputRow,
  SQLiteTransactionOptions,
} from './api';
import { SQLiteBulkWriteError } from './errors';
import {
  type Locks,
  stagingLockName,
  stagingTableName,
  staleStagingTables,
  sweepLockName,
} from './locks';
import type { Logger } from './logger';
import {
  assertColumnType,
  assertGeneratedExpression,
  quoteIdent,
} from './utils';

// Structural, and deliberately narrower than SQLiteQueryAPI: bulk needs only
// these three calls, and requiring the full surface would make every unit test
// build a complete stub to exercise a single INSERT.
/**
 * The options these three actually pass is a signal and nothing else, so that
 * is what they ask for. `any` here accepted a misspelt option in silence, which
 * is the one thing a narrow type was never meant to buy.
 */
type BulkCallOptions = { signal?: AbortSignal | undefined };

export type WriteFn = (
  sql: string,
  params?: unknown[],
  options?: BulkCallOptions,
) => Promise<{ result: unknown[]; affected: number }>;

export type ReadFn = (
  sql: string,
  params?: unknown[],
  options?: BulkCallOptions,
) => Promise<unknown[]>;

export type TransactionFn = <T>(
  callback: (db: {
    write: (
      sql: string,
      params?: unknown[],
      options?: BulkCallOptions,
    ) => Promise<{ result: unknown[]; affected: number }>;
  }) => Promise<T>,
  options?: SQLiteTransactionOptions,
) => Promise<T>;

/**
 * How long the best-effort staging DROP may wait for a worker before the
 * caller is let go. Not an option: a caller has nothing useful to tune here,
 * and the consequence of expiry is a table the sweep already collects.
 */
const DROP_STAGING_TIMEOUT = 5_000;

/**
 * Returned by every `enqueue()` that does not have to wait. Shared rather than
 * created per call: the hot path allocates nothing.
 */
const ADMITTED = Promise.resolve();

/** A promise and the handle that resolves it. */
const makeRoom = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

export const createBulk = (shared: {
  file: string;
  locks: Locks;
  logger: Logger;
  maxVariables?: number;
}) => {
  const { file, locks, maxVariables = 32766, logger } = shared;

  // Net 2 of the three-net cleanup: orphans left by a closed tab or a crashed
  // session.
  //
  // It runs at the FIRST output() of this client, never at open(). The writer is
  // only designated lazily, on the first write, so a sweep at open would race
  // the n workers. That is the argument against making it eager to make the
  // first output() faster — an attractive idea that the two-stage split does
  // NOT rule out on its own.
  //
  // The memo lives HERE rather than in forTarget on purpose: a transaction
  // builds its own target, so a per-target memo would sweep on every
  // tx.output() instead of once per client.
  let swept: Promise<void> | undefined;

  return (target: {
    read: ReadFn;
    write: WriteFn;
    transaction: TransactionFn;
  }) => {
    const { read, write, transaction } = target;

    // bulkWrite, sweepOnce, indexStatements and output move in here VERBATIM.
    // Not one character of their bodies changes: they already read `read`,
    // `write`, `transaction`, `file`, `locks`, `logger` and `maxVariables` as
    // free variables, and all seven are still in scope. This task is a
    // relocation; any behavioural edit smuggled into it is a defect.

    /**
     * Creates a bulk write utility for efficiently inserting many rows.
     * Automatically batches inserts to stay within SQLite variable limits.
     *
     * @param table - Table name to insert into
     * @param keys - Column names for the insert
     * @returns Object with enqueue() to add rows and close() to flush remaining
     */
    const bulkWrite = <KEYS extends string>(
      table: string,
      keys: KEYS[],
      options?: SQLiteBulkWriteOptions,
      /** Internal: awaited before the first batch. `output()` passes its staging DDL. */
      before?: Promise<unknown>,
    ) => {
      const signal = options?.signal;
      const maxBufferSize = Math.floor(maxVariables / keys.length);
      // Two batches' worth by default: the batch is the unit that gets queued,
      // so anything smaller than one is meaningless and two is the smallest
      // window that lets a batch settle while another is being filled. Derived
      // rather than fixed because the same row count means a different number
      // of INSERTs on a wide table than on a narrow one. It bounds ROWS — what
      // they weigh is the caller's business, and `queueSize` is theirs to set.
      // Raised to 1 rather than trusted: a flush always queues at least one
      // row, so anything lower can never be satisfied and would park the
      // producer for ever. This is the one place an explicit value is not taken
      // as given — the spec's "no clamping" was about a value too HIGH, whose
      // worst case is the behaviour that predates this option.
      const queueSize = Math.max(1, options?.queueSize ?? 2 * maxBufferSize);

      const buffer: { [K in KEYS]: any }[] = [];

      let writePromise = Promise.resolve<number>(0);
      let failure: unknown;
      let closed = false;
      let rowsWritten = 0;
      let rowsNotWritten = 0;
      /** Rows handed to a batch that has not settled yet. */
      let queuedRows = 0;
      /** Shared by every enqueue() parked while the queue is full. */
      let room: { promise: Promise<void>; resolve: () => void } | undefined;

      const releaseRoom = () => {
        room?.resolve();
        room = undefined;
      };

      // The abort must release a producer parked on enqueue(): the batch it
      // waits for may never settle — the pool can stay empty on a VFS that
      // rotates one exclusive handle — and the release is what lets its next
      // enqueue() throw signal.reason. Removed by close(), so a signal the
      // caller keeps does not collect one listener per writer.
      signal?.addEventListener('abort', releaseRoom, { once: true });

      const fail = (): SQLiteBulkWriteError =>
        new SQLiteBulkWriteError(
          `bulkWrite into "${table}" failed after ${rowsWritten} row(s); ${rowsNotWritten} row(s) were not written.`,
          { rowsWritten, rowsNotWritten },
          { cause: failure },
        );

      const flush = () => {
        const toInsert = [...buffer];
        buffer.length = 0;
        queuedRows += toInsert.length;
        // The chain never rejects: a rejection here is what used to skip every
        // later `.then()` and drop already-spliced rows without a word (B5).
        const runBatch = async (currentAffected: number) => {
          if (failure) {
            rowsNotWritten += toInsert.length;
            return currentAffected;
          }
          // Skips a batch the abort beat to the start, so no round trip is
          // paid for rows that will not be written.
          if (signal?.aborted) {
            rowsNotWritten += toInsert.length;
            return currentAffected;
          }
          try {
            if (before) await before;
            // The signal goes DOWN to the write. An earlier version withheld
            // it, reasoning that an aborted batch would be caught below and
            // recorded as `failure`, making close() reject with
            // SQLiteBulkWriteError instead of the caller's reason. The premise
            // was right and the conclusion wrong: the catch is ours, and it
            // tells the two apart.
            //
            // Withholding it cost a hang. A batch already in flight had no way
            // to be rejected, so a write that never settles — OPFSCoopSyncVFS
            // on an engine without `readwrite-unsafe`, waiting on a handle
            // hand-over that never comes — left this chain pending for ever,
            // and close() with it. Observed on macOS Safari 27.0.
            const { affected } = await write(
              `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES ${toInsert.map(() => `(${keys.map(() => '?')})`)}`,
              toInsert.flatMap((data) => keys.map((k) => data[k])),
              { signal },
            );
            rowsWritten += toInsert.length;
            return currentAffected + affected;
          } catch (error) {
            // An abort is not a failure. This branch is what keeps close()
            // rejecting with `signal.reason` rather than SQLiteBulkWriteError.
            if (signal?.aborted) {
              rowsNotWritten += toInsert.length;
              return currentAffected;
            }
            failure = error;
            // A multi-row INSERT is statement-atomic: nothing of this batch landed.
            rowsNotWritten += toInsert.length;
            return currentAffected;
          }
        };
        writePromise = writePromise.then(async (currentAffected) => {
          try {
            return await runBatch(currentAffected);
          } finally {
            // Every exit passes here — success, latched failure, and the batch
            // an abort skipped. One missed decrement and enqueue() never
            // resolves again.
            queuedRows -= toInsert.length;
            if (queuedRows < queueSize) releaseRoom();
          }
        });
      };

      const failClosed = (): SQLiteBulkWriteError =>
        new SQLiteBulkWriteError(`Bulk writer for "${table}" is closed.`, {
          rowsWritten,
          rowsNotWritten,
        });

      return {
        enqueue: (data: { [K in KEYS]: any }) => {
          if (closed) throw failClosed();
          // Before the failure guard: an aborted writer is not a failed one,
          // and the caller who aborted wants their own reason back, not a
          // report about rows they stopped caring about.
          signal?.throwIfAborted();
          if (failure) throw fail();
          buffer.push(data);
          if (buffer.length >= maxBufferSize) flush();
          if (queuedRows < queueSize) return ADMITTED;
          // One deferred for every caller while the queue is full: enqueue() is
          // not concurrent-safe today and this does not make it so.
          room ??= makeRoom();
          return room.promise;
        },
        close: async () => {
          if (closed) throw failClosed();
          try {
            if (buffer.length) flush();
            const affected = await writePromise;
            // Ordered ahead of the failure check for the same reason: a batch
            // skipped by the abort is not a batch that failed.
            signal?.throwIfAborted();
            if (failure) throw fail();
            closed = true;
            return affected;
          } finally {
            signal?.removeEventListener('abort', releaseRoom);
          }
        },
      };
    };

    const sweepOnce = () => {
      // MANDATORY guard: without the Web Locks API there is no way to tell an
      // in-flight staging table from an orphan, and `heldNames()` returns []. A
      // sweep in that state would drop another tab's live staging table — worse
      // than not sweeping. The sweep is opportunistic; skipping it is correct.
      if (!locks.available) {
        if (swept === undefined) {
          swept = Promise.resolve();
          logger.warn(
            'navigator.locks is unavailable; skipping the staging sweep',
          );
        }
        return swept;
      }

      // tryWithLock, not withLock: awaiting this lock inside an open transaction
      // would hold SQLite's write lock while waiting on a holder that may itself
      // be waiting for that write lock — reachable with two clients in one tab.
      //
      // A refused attempt is memoized deliberately. If the lock was held, another
      // client was sweeping; retrying would put a lock request in front of every
      // output() for nothing.
      swept ??= locks
        .tryWithLock(sweepLockName(file), async () => {
          const rows = await read(
            `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'`,
          );
          const tables = rows
            .map((row) => (row as { name?: unknown }).name)
            .filter(
              (name: unknown): name is string => typeof name === 'string',
            );
          if (!tables.length) return;
          const stale = staleStagingTables(
            tables,
            await locks.heldNames(),
            file,
          );
          for (const orphan of stale) {
            await write(`DROP TABLE IF EXISTS ${quoteIdent(orphan)}`);
          }
        })
        .then(() => undefined)
        .catch(() => {
          // A failed sweep must never fail the output() that triggered it.
        });
      return swept;
    };

    /** CREATE INDEX statements for the final table, built after the rename. */
    const indexStatements = <SCHEMA extends Schema>(
      table: string,
      options?: SQLiteOutputOptions<SCHEMA>,
    ): string[] => {
      const statements: string[] = [];
      for (const index of options?.indexes ?? []) {
        const columns = Array.isArray(index)
          ? index
          : typeof index === 'object'
            ? 'column' in index
              ? [index.column]
              : index.columns
            : [index];
        const unique =
          !Array.isArray(index) && typeof index === 'object' && !!index.unique;
        if (!columns?.length) continue;
        const names = columns.map(String);
        statements.push(
          `CREATE${unique ? ' UNIQUE' : ''} INDEX IF NOT EXISTS ${quoteIdent(`${table}_${names.join('_')}_${unique ? 'U' : 'IDX'}`)} ON ${quoteIdent(table)}(${names.map(quoteIdent).join(',')})`,
        );
      }
      return statements;
    };

    /**
     * Builds a table from scratch and swaps it in atomically — MongoDB's $out.
     *
     * Rows are loaded into __bsq_staging_<uuid> (a normal table in main, never
     * TEMP: a TEMP table lives in the temp database and cannot be renamed across
     * databases, and is invisible to the other pool workers). The final swap is
     * one short transaction: DROP the target, RENAME the staging table onto it,
     * then build the indexes with their final names — SQLite has no
     * ALTER INDEX ... RENAME, so indexes built before the swap would keep the
     * staging name forever (D3).
     *
     * Until close() succeeds the previous table stays intact and fully
     * populated. That is the guarantee output() did not have (B5): it used to
     * DROP and CREATE eagerly, so a failure anywhere in the load left the caller
     * with no table at all.
     */
    const output = <SCHEMA extends Schema>(
      table: string,
      schema: SCHEMA,
      options?: SQLiteOutputOptions<SCHEMA>,
    ) => {
      const staging = stagingTableName(crypto.randomUUID());

      const normalizedSchema = Object.entries(schema).map(([k, v]) => {
        const type = assertColumnType(typeof v === 'string' ? v : v.type, k);
        const unique = typeof v === 'object' && !!v.unique;
        const notnull = typeof v === 'object' && !!v.required;
        const generated =
          typeof v === 'object' && v.generated
            ? assertGeneratedExpression(v.generated, k)
            : undefined;
        return { name: k, type, unique, notnull, generated };
      });

      // Held for as long as the staging table exists: this is what tells another
      // tab's sweep that the table is in flight and must not be collected.
      const lockHeld = locks.hold(stagingLockName(file, staging));

      const createStaging = sweepOnce()
        .then(() =>
          write(`
			CREATE TABLE ${quoteIdent(staging)}(
				${normalizedSchema
          .map(({ name, type, unique, notnull, generated }) => {
            return `${quoteIdent(name)} ${type} ${unique ? 'UNIQUE' : ''} ${notnull ? 'NOT NULL' : ''} ${generated ? `GENERATED ALWAYS AS ${generated}` : ''}`;
          })
          .join(',')}
			)`),
        )
        .then(() => undefined);

      const { enqueue, close } = bulkWrite(
        staging,
        Object.keys(schema).filter(
          (col) => typeof schema[col] !== 'object' || !schema[col].generated,
        ),
        { signal: options?.signal, queueSize: options?.queueSize },
        createStaging,
      );

      const releaseLock = async () => {
        (await lockHeld)();
      };

      const dropStaging = () =>
        Promise.race([
          write(`DROP TABLE IF EXISTS ${quoteIdent(staging)}`),
          // Bounded, because this runs on the path whose whole point is to
          // stop quickly. The DROP is a write, so it needs a worker — and
          // after an abort the pool may still be finishing the batch the abort
          // skipped, or be stuck for the reason the caller aborted over.
          // Unbounded, a best-effort cleanup would hold close() open forever.
          //
          // Giving up here is safe by construction: the fallback is an orphan
          // staging table, and releasing the staging lock — which happens
          // AFTER this attempt, deliberately — is what tells another sweep it
          // may collect it.
          new Promise((resolve) => setTimeout(resolve, DROP_STAGING_TIMEOUT)),
        ]).catch(() => {
          // Net 2 (the sweep) collects what this could not.
        });

      return {
        enqueue: (data: SQLiteOutputRow<SCHEMA>) => enqueue(data as any),

        close: async () => {
          let affected: number;
          try {
            // Ensure the staging table exists even when no rows were enqueued —
            // bulkWrite.close() only awaits createStaging via flush(), and flush()
            // is skipped when the buffer is empty.
            await createStaging;
            affected = await close();
          } catch (error) {
            await dropStaging();
            await releaseLock();
            throw error;
          }

          try {
            await transaction(async (tx) => {
              await tx.write(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
              await tx.write(
                `ALTER TABLE ${quoteIdent(staging)} RENAME TO ${quoteIdent(table)}`,
              );
              for (const statement of indexStatements(table, options)) {
                await tx.write(statement);
              }
            });
          } catch (error) {
            await dropStaging();
            throw error;
          } finally {
            await releaseLock();
          }

          return affected;
        },
      };
    };

    return { bulkWrite, output };
  };
};
