import { BulkWriteError } from './errors';
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
  temp?: boolean;
};

// Structural mirror of SQLiteDB['write'].
// Kept inline to avoid a circular import: client.ts imports createBulk, so
// createBulk cannot import SQLiteDB from client.ts.
type WriteFn = (
  sql: string,
  params?: any[],
  options?: any,
) => Promise<{ result: any[]; affected: number }>;

export const createBulk = (deps: { write: WriteFn; maxVariables?: number }) => {
  const { write, maxVariables = 32766 } = deps;

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

  /**
   * Creates a table output utility for efficiently creating and populating tables.
   * Drops existing table, creates new one with schema, and provides bulk insert.
   *
   * @param table - Table name to create
   * @param schema - Schema definition with column types and constraints
   * @param options - Optional indexes and temporary table flag
   * @returns Object with enqueue() to add rows and close() to finalize and create indexes
   */
  const output = <SCHEMA extends Schema>(
    table: string,
    schema: SCHEMA,
    options?: OutputOptions<SCHEMA>,
  ) => {
    const { enqueue, close } = bulkWrite(
      table,
      Object.keys(schema).filter(
        (col) => typeof schema[col] !== 'object' || !schema[col].generated,
      ),
    );

    // Normalize schema entries to internal format
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

    // Drop and recreate table with schema
    const createTablePromise = write(`
			DROP TABLE IF EXISTS ${quoteIdent(table)}
		`).then(async () => {
      await write(`
				CREATE ${options?.temp ? 'TEMPORARY' : ''} TABLE ${quoteIdent(table)}(
					${normalizedSchema
            .map(({ name, type, unique, notnull, generated }) => {
              return `${quoteIdent(name)} ${type} ${unique ? 'UNIQUE' : ''} ${notnull ? 'NOT NULL' : ''} ${generated ? `GENERATED ALWAYS AS ${generated}` : ''}`;
            })
            .join(',')}
				)
			`);
    });

    return {
      // Add a row, waiting for table creation if needed
      enqueue: (
        data: {
          [K in keyof SCHEMA as SCHEMA[K] extends { generated: string }
            ? never
            : K]: any;
        },
      ) => {
        createTablePromise.then(() => enqueue(data));
      },
      // Flush rows, create indexes, and return total affected count
      close: () => {
        return createTablePromise
          .then(() => close())
          .then(async (affected) => {
            // Create requested indexes after data is inserted
            if (options?.indexes) {
              for (const index of options.indexes) {
                const columns =
                  typeof index === 'string'
                    ? [index]
                    : Array.isArray(index)
                      ? index
                      : typeof index === 'object'
                        ? 'column' in index
                          ? [index.column]
                          : index.columns
                        : undefined;
                const unique =
                  !Array.isArray(index) &&
                  typeof index === 'object' &&
                  !!index.unique;
                if (!columns) continue;
                await write(
                  `CREATE ${unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS ${quoteIdent(`${table}_${columns.join('_')}_${unique ? 'U' : 'IDX'}`)} ON ${quoteIdent(table)}(${columns.map(String).map(quoteIdent).join(',')})`,
                );
              }
            }
            return affected;
          });
      },
    };
  };

  return { bulkWrite, output };
};
