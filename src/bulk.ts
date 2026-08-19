import { BulkWriteError } from './errors';
import {
  type Locks,
  stagingLockName,
  stagingTableName,
  staleStagingTables,
  sweepLockName,
} from './locks';
import {
  assertColumnType,
  assertGeneratedExpression,
  quoteIdent,
} from './utils';

// Schema and related types for schema-driven bulk write operations.

export type Schema = Record<
  string,
  | string
  | { type: string; generated?: string; required?: boolean; unique?: boolean }
>;

export type Index<SCHEMA extends Schema> =
  | keyof SCHEMA
  | (keyof SCHEMA)[]
  | ({ unique?: boolean } & (
      | {
          column: keyof SCHEMA;
        }
      | { columns: (keyof SCHEMA)[] }
    ));

export type OutputOptions<SCHEMA extends Schema> = {
  indexes?: Index<SCHEMA>[];
};

// Structural mirror of SQLiteDB['write'].
// Kept inline to avoid a circular import: client.ts imports createBulk, so
// createBulk cannot import SQLiteDB from client.ts.
type WriteFn = (
  sql: string,
  params?: any[],
  options?: any,
) => Promise<{ result: any[]; affected: number }>;

// Structural mirrors of SQLiteDB methods. Kept inline to avoid a circular
// import: client.ts imports createBulk, so createBulk cannot import from it.
type ReadFn = (sql: string, params?: any[], options?: any) => Promise<any[]>;

type TransactionFn = <T>(
  callback: (db: {
    write: (
      sql: string,
      params?: any[],
      options?: any,
    ) => Promise<{ result: any[]; affected: number }>;
  }) => Promise<T>,
  options?: { readOnly?: boolean; autoCommit?: boolean },
) => Promise<T>;

export const createBulk = (deps: {
  write: WriteFn;
  read: ReadFn;
  transaction: TransactionFn;
  file: string;
  locks: Locks;
  maxVariables?: number;
}) => {
  const { write, read, transaction, file, locks, maxVariables = 32766 } = deps;

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
    /** Internal: awaited before the first batch. `output()` passes its staging DDL. */
    before?: Promise<unknown>,
  ) => {
    const maxBufferSize = Math.floor(maxVariables / keys.length);

    const buffer: { [K in KEYS]: any }[] = [];

    let writePromise = Promise.resolve<number>(0);
    let failure: unknown;
    let rowsWritten = 0;
    let rowsNotWritten = 0;

    const fail = (): BulkWriteError =>
      new BulkWriteError(
        `bulkWrite into "${table}" failed after ${rowsWritten} row(s); ${rowsNotWritten} row(s) were not written.`,
        { rowsWritten, rowsNotWritten },
        { cause: failure },
      );

    const flush = () => {
      const toInsert = [...buffer];
      buffer.length = 0;
      // The chain never rejects: a rejection here is what used to skip every
      // later `.then()` and drop already-spliced rows without a word (B5).
      writePromise = writePromise.then(async (currentAffected) => {
        if (failure) {
          rowsNotWritten += toInsert.length;
          return currentAffected;
        }
        try {
          if (before) await before;
          const { affected } = await write(
            `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(',')}) VALUES ${toInsert.map(() => `(${keys.map(() => '?')})`)}`,
            toInsert.flatMap((data) => keys.map((k) => data[k])),
          );
          rowsWritten += toInsert.length;
          return currentAffected + affected;
        } catch (error) {
          failure = error;
          // A multi-row INSERT is statement-atomic: nothing of this batch landed.
          rowsNotWritten += toInsert.length;
          return currentAffected;
        }
      });
    };

    return {
      enqueue: (data: { [K in KEYS]: any }) => {
        if (failure) throw fail();
        buffer.push(data);
        if (buffer.length >= maxBufferSize) flush();
      },
      close: async () => {
        if (buffer.length) flush();
        const affected = await writePromise;
        if (failure) throw fail();
        return affected;
      },
    };
  };

  // Net 2 of the three-net cleanup: orphans left by a closed tab or a crashed
  // session. Runs at the FIRST output() of this client, not at open() — the
  // writer is only designated lazily on the first write, and a sweep at open
  // would race the n workers.
  let swept: Promise<void> | undefined;

  const sweepOnce = () => {
    // MANDATORY guard: without the Web Locks API there is no way to tell an
    // in-flight staging table from an orphan, and `heldNames()` returns []. A
    // sweep in that state would drop another tab's live staging table — worse
    // than not sweeping. The sweep is opportunistic; skipping it is correct.
    if (!locks.available) return Promise.resolve();

    swept ??= locks
      .withLock(sweepLockName(file), async () => {
        const rows = await read(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__bsq_staging_%'`,
        );
        const tables = rows
          .map((row: any) => row.name)
          .filter((name: unknown): name is string => typeof name === 'string');
        if (!tables.length) return;
        const stale = staleStagingTables(tables, await locks.heldNames(), file);
        for (const orphan of stale) {
          await write(`DROP TABLE IF EXISTS ${quoteIdent(orphan)}`);
        }
      })
      .catch(() => {
        // A failed sweep must never fail the output() that triggered it.
      });
    return swept;
  };

  /** CREATE INDEX statements for the final table, built after the rename. */
  const indexStatements = <SCHEMA extends Schema>(
    table: string,
    options?: OutputOptions<SCHEMA>,
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
    options?: OutputOptions<SCHEMA>,
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
      createStaging,
    );

    const releaseLock = async () => {
      (await lockHeld)();
    };

    const dropStaging = () =>
      write(`DROP TABLE IF EXISTS ${quoteIdent(staging)}`).catch(() => {
        // Net 2 (the sweep) collects what this could not.
      });

    return {
      enqueue: (
        data: {
          [K in keyof SCHEMA as SCHEMA[K] extends { generated: string }
            ? never
            : K]: any;
        },
      ) => enqueue(data as any),

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
