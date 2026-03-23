import { Logger } from '@lalex/console';
import { defer } from '@lalex/promises';
import { createClientDebug } from './debug';
import { WorkerOrchestrator, WorkerStatuses } from './orchestrator';
import type { SQLiteVFS, WorkerMessageData } from './types';
import { isWriteQuery } from './utils';

const LL = Logger.scope('sqlite/client');
LL.level = 'info';
LL.date = true;

/**
 * SQLite client for browser environments using a pool of Web Workers.
 *
 * Features:
 * - Worker pool management for concurrent SQLite operations
 * - Read/write query differentiation with exclusive write access
 * - Streaming results support for large datasets
 * - Transaction support with rollback capability
 */

const DEFAULT_POOL_SIZE = 2;

/**
 * Configuration options for creating a SQLite client.
 */
export type CreateSQLLiteClientOptions = {
	name?: string;
	poolSize?: number;
	vfs?: SQLiteVFS;
	pragmas?: Record<string, string>;
	debug?: boolean;
};

/**
 * Query execution options.
 */
type SQLiteQueryOptions<T extends Record<string, unknown>> = {
	id?: string;
	chunkSize?: number;
	signal?: AbortSignal;
	debug?: string;
};

type SQLiteStreamOptions<T extends Record<string, unknown>> = SQLiteQueryOptions<T> & {
	signal?: AbortSignal;
};

let clientCount = 0;

/**
 * Main SQLite database API.
 */
export type SQLiteDB = {
	read: <T extends Record<string, unknown>>(
		sql: string,
		params?: any[],
		options?: SQLiteQueryOptions<T>,
	) => Promise<T[]>;
	write: <T extends Record<string, unknown>>(
		sql: string,
		params?: any[],
		options?: SQLiteQueryOptions<T>,
	) => Promise<{ result: T[]; affected: number }>;
	stream: <T extends Record<string, unknown>>(
		sql: string,
		params?: any[],
		options?: SQLiteStreamOptions<T>,
	) => AsyncGenerator<T[]>;
	one: <T extends Record<string, unknown>>(
		sql: string,
		params?: any[],
		options?: SQLiteQueryOptions<T>,
	) => Promise<T | undefined>;
};

const DEFAULT_VFS = 'OPFSPermutedVFS';

/**
 * Creates a SQLite client with a pool of Web Workers.
 *
 * @param file - Database file path
 * @param clientOptions - Configuration options
 * @returns SQLite database API with read/write/stream/transaction methods
 */
export const createSQLiteClient = ((file: string, clientOptions?: CreateSQLLiteClientOptions) => {
	const clientIndex = ++clientCount;

	const clientPrefix = `${clientOptions?.name ?? 'SQLite'} ${clientIndex}`;

	const poolSize = clientOptions?.poolSize ?? DEFAULT_POOL_SIZE;

	const pool: PoolWorker[] = [];

	// Orchestrator manages worker synchronization and status tracking
	const orchestrator = new WorkerOrchestrator(poolSize);

	const vfs = clientOptions?.vfs ?? DEFAULT_VFS;

	if (vfs === 'AccessHandlePoolVFS' && poolSize > 1) {
		throw new Error('AccessHandlePoolVFS does not support pool sizes greater than 1');
	}

	const {
		state: debug,
		createRequestDebugState,
		createWorkerDebugState,
		createQueryDebugState,
	} = clientOptions?.debug
		? createClientDebug(file, orchestrator, { vfs, pragmas: clientOptions?.pragmas ?? {}, name: clientPrefix })
		: {};

	/**
	 * Worker instance extended with pool-specific properties.
	 */
	type PoolWorker = Worker & {
		index: number;
		available: boolean;
		query: <T extends Record<string, unknown> = Record<string, unknown>>(
			sql: string,
			params?: unknown[],
			options?: SQLiteQueryOptions<T>,
		) => AsyncGenerator<T[] | number>;
	};

	/**
	 * Creates a new worker and adds it to the pool.
	 * Sets up message routing via callId for query responses.
	 */
	const createWorker = () => {
		const deferredInit = defer<PoolWorker>();

		const workerName = `${clientPrefix} / Worker ${pool.length + 1}`;
		const index =
			pool.push(
				new Worker(/* webpackChunkName: "sqlite" */ new URL('./worker.ts', import.meta.url), {
					name: workerName,
				}) as PoolWorker,
			) - 1;
		const worker = Object.assign(pool[index], {
			index,
			available: false,
		} as PoolWorker);

		const state = createWorkerDebugState?.(index, workerName);

		let currentCallId = 0;

		// Deferred promise for streaming query results one chunk at a time
		let deferredChunk: ReturnType<typeof defer<unknown[] | number>> | undefined;

		// Message handler routes responses by callId
		worker.onmessage = ({ data }: MessageEvent<WorkerMessageData>) => {
			const { callId, type } = data;
			if (callId === 0 && type === 'ready') {
				worker.available = true;
				if (state) state.initializationTime = Date.now();
				deferredInit.resolve(worker);
			}
			if (deferredChunk && callId === currentCallId) {
				switch (type) {
					case 'chunk': {
						if (state?.currentRequest?.currentQuery) {
							state.currentRequest.currentQuery.firstRowTime ??= Date.now();
						}
						deferredChunk.resolve(data.data);
						deferredChunk = defer<unknown[] | number>();
						break;
					}
					case 'done': {
						const affected = data.affected;
						if (state?.currentRequest?.currentQuery) {
							state.currentRequest.currentQuery.affectedRows = affected;
							state.currentRequest.affectedRows += affected;
							state.currentRequest.currentQuery.endTime = Date.now();
						}
						deferredChunk.resolve(affected);
						deferredChunk = undefined;
						break;
					}
					case 'error': {
						const error = new Error(data.message, { cause: data.cause });
						if (state?.currentRequest?.currentQuery) {
							state.currentRequest.currentQuery.error = error;
							state.currentRequest.currentQuery.endTime = Date.now();
						}
						deferredChunk.reject(error);
						deferredChunk = undefined;
						break;
					}
				}
			}
		};

		/**
		 * Generator function that executes a query and streams results.
		 * Manages worker ready state and abort signals.
		 */
		const query = async function* <T extends Record<string, unknown> = Record<string, unknown>>(
			sql: string,
			params?: unknown[],
			options?: SQLiteQueryOptions<T>,
		): AsyncGenerator<T[] | number> {
			try {
				// Mark worker as busy
				worker.available = false;
				if (deferredChunk) {
					console.error(`Previous query not finished on worker ${index + 1}`);
					throw new Error('Worker is already processing a query');
				}

				if (state?.currentRequest) {
					const queryState = createQueryDebugState?.(index, sql, params);
					state.currentRequest.currentQuery = queryState;
				}

				// Extract query options
				const { chunkSize = 500, signal } = options ?? {};

				// Set up abort handling
				const signalAbortHandler = () => {
					orchestrator.setStatus(index, WorkerStatuses.ABORTING, WorkerStatuses.RUNNING);
				};
				signal?.addEventListener('abort', signalAbortHandler);

				// Prepare for streaming chunks
				deferredChunk = defer<unknown[] | number>();

				// Send query to worker with options
				worker.postMessage({ type: 'query', callId: ++currentCallId, sql, params, options: { chunkSize } });

				// Stream chunks until query completes
				while (deferredChunk) {
					const chunk = await deferredChunk.promise;
					yield chunk as T[] | number;
				}
				signal?.removeEventListener('abort', signalAbortHandler);
			} finally {
				// Always restore worker to ready state
				deferredChunk = undefined;
				worker.available = true;
			}
		};

		// Attach query method to worker
		Object.assign(worker, { query });

		// Initialize worker with database file and configuration
		worker.postMessage({
			callId: 0,
			type: 'open',
			file,
			flags: orchestrator.sharedArrayBuffer,
			index,
			vfs,
			pragmas: clientOptions?.pragmas,
		});

		return deferredInit.promise;
	};

	// Queue for readers waiting for an available worker
	const readerRequestQueue: Array<(worker: PoolWorker) => void> = [];
	// Queue for writers waiting for exclusive access to the writer worker
	const writerRequestQueue: Array<(worker: PoolWorker) => void> = [];
	// Index of the worker designated for write operations (-1 if none)
	let currentWriterIndex = -1;

	/**
	 * Acquires an available worker from the pool.
	 * For write operations, uses a dedicated writer worker to prevent conflicts.
	 * For read operations, uses any available worker.
	 */
	const acquireWorker = (write = false) => {
		// If write operation and a writer is designated
		if (write && currentWriterIndex > -1) {
			const writer = pool[currentWriterIndex];
			if (writer.available) return writer;
			return;
		}

		// Find any available worker in the pool
		const availableWorker = pool.find((w) => {
			if (w.available) return true;
			return false;
		});

		// If this is a write operation, designate this worker as the writer
		if (availableWorker && write) {
			currentWriterIndex = availableWorker.index;
		}
		return availableWorker;
	};

	/**
	 * Waits for a worker to become available.
	 * Adds request to appropriate queue (reader or writer) if no worker is ready.
	 */
	const acquireNextWorker = async (write = false) => {
		const availableWorker = acquireWorker(write);

		if (availableWorker) {
			LL.debug(`Acquire ${write ? 'writer' : 'reader'} worker ${availableWorker.index + 1}`);
			availableWorker.available = false;
			return availableWorker;
		}

		// Queue the request and wait for worker to become available
		const { promise, resolve } = defer<PoolWorker>();
		if (write) {
			if (debug) debug.queue.write++;
			writerRequestQueue.push((worker) => {
				worker.available = false;
				resolve(worker);
			});
		} else {
			if (debug) debug.queue.read++;
			readerRequestQueue.push((worker) => {
				worker.available = false;
				resolve(worker);
			});
		}
		return promise;
	};

	/**
	 * Public API to get next available worker.
	 * Returns the worker from the pool by index.
	 */
	const getNextAvailableWorker = async (write = false) => {
		const requestState = createRequestDebugState?.();
		const availableWorker = await acquireNextWorker(write);
		requestState?.assign(availableWorker.index);
		return pool[availableWorker.index];
	};

	/**
	 * Releases a worker back to the pool and processes queued requests.
	 * Prioritizes writer requests, then reader requests.
	 */
	const releaseWorker = (worker: PoolWorker) => {
		LL.debug(`Releasing worker ${worker.index + 1}`);
		const requestState = debug?.workers[worker.index]?.currentRequest;
		if (requestState) requestState.releaseTime = Date.now();

		// Process pending writer requests first
		if (writerRequestQueue.length) {
			if (currentWriterIndex === worker.index || currentWriterIndex === -1) {
				LL.verb('Give', worker.index + 1, 'to next writer request');
				if (debug) debug.queue.write--;
				writerRequestQueue.shift()?.(worker);
				return;
			}
		}

		// Process pending reader requests
		if (readerRequestQueue.length) {
			// If this was the writer, clear the writer designation
			if (currentWriterIndex === worker.index) {
				currentWriterIndex = -1;
			}
			if (debug) debug.queue.read--;
			LL.verb('Give', worker.index + 1, 'to next reader request');
			readerRequestQueue.shift()?.(worker);
			return;
		}
		orchestrator.setStatus(worker.index, WorkerStatuses.READY);
	};

	/**
	 * Helper to execute a read query and collect all results.
	 */
	const readWorker = async <T extends Record<string, unknown> = Record<string, unknown>>(
		worker: PoolWorker,
		sql: string,
		params?: unknown[],
		options?: SQLiteQueryOptions<T>,
	) => {
		const result: T[] = [];
		for await (const chunk of worker.query<T>(sql, params, options)) {
			if (typeof chunk !== 'number') {
				result.push(...chunk);
			}
		}
		return result;
	};

	/**
	 * Executes a read query and returns all results.
	 * Automatically acquires and releases a worker from the pool.
	 */
	const read = async <T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
		options?: SQLiteQueryOptions<T>,
	) => {
		const worker = await getNextAvailableWorker(isWriteQuery(sql));
		// LL.wth('Got', worker.index + 1, 'to read', debugSQLQuery(sql, params));
		try {
			return await readWorker(worker, sql, params, options);
		} finally {
			// LL.wth('Release', worker.index + 1, 'after read');
			releaseWorker(worker);
		}
	};

	/**
	 * Helper to execute a streaming query on a specific worker.
	 */
	const streamWorker = async function* <T extends Record<string, unknown> = Record<string, unknown>>(
		worker: PoolWorker,
		sql: string,
		params?: unknown[],
		options?: SQLiteQueryOptions<T>,
	) {
		for await (const chunk of worker.query<T>(sql, params, options)) {
			if (typeof chunk !== 'number') {
				yield chunk;
			}
		}
	};

	/**
	 * Executes a query and streams results in chunks.
	 * Useful for large result sets to avoid memory overflow.
	 */
	const stream = async function* <T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
		options?: SQLiteQueryOptions<T>,
	) {
		const worker = await getNextAvailableWorker(isWriteQuery(sql));
		// LL.wth('Got', worker.index + 1, 'to stream', debugSQLQuery(sql, params));
		try {
			for await (const chunk of streamWorker<T>(worker, sql, params, options)) {
				yield chunk;
			}
		} finally {
			// LL.wth('Release', worker.index + 1, 'after stream');
			releaseWorker(worker);
		}
	};

	/**
	 * Helper to execute a write query and return both results and affected count.
	 */
	const writeWorker = async <T extends Record<string, unknown> = Record<string, unknown>>(
		worker: PoolWorker,
		sql: string,
		params?: unknown[],
		options?: SQLiteQueryOptions<T>,
	) => {
		const result: T[] = [];
		let affected = 0;
		for await (const chunk of worker.query<T>(sql, params, options)) {
			if (typeof chunk !== 'number') {
				result.push(...chunk);
			} else {
				affected = chunk;
			}
		}
		return { result, affected };
	};

	/**
	 * Executes a write query and returns results with affected row count.
	 * Automatically acquires and releases a worker from the pool.
	 */
	const write = async <T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
		options?: SQLiteQueryOptions<T>,
	) => {
		const worker = await getNextAvailableWorker(isWriteQuery(sql));
		// LL.wth('Got', worker.index + 1, 'to write', debugSQLQuery(sql, params));
		try {
			return await writeWorker(worker, sql, params, options);
		} finally {
			// LL.wth('Release', worker.index + 1, 'after write');
			releaseWorker(worker);
		}
	};

	/**
	 * Helper to fetch a single row from a query result.
	 * Aborts after receiving the first row to avoid unnecessary work.
	 */
	const oneWorker = async <T extends Record<string, unknown> = Record<string, unknown>>(
		worker: PoolWorker,
		sql: string,
		params?: unknown[],
		options?: Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>,
	) => {
		let result: T | undefined;
		const abortController = new AbortController();
		for await (const chunk of streamWorker<T>(worker, sql, params, {
			...options,
			signal: abortController.signal,
			chunkSize: 1,
		})) {
			result = chunk[0];
			abortController.abort();
		}
		return result;
	};

	/**
	 * Executes a query and returns only the first row.
	 * Automatically aborts after receiving first result for efficiency.
	 */
	const one = async <T extends Record<string, unknown> = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
		options?: Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>,
	) => {
		const worker = await getNextAvailableWorker(isWriteQuery(sql));
		// LL.wth('Got', worker.index + 1, 'to one', debugSQLQuery(sql, params));
		try {
			return await oneWorker(worker, sql, params, options);
		} finally {
			// LL.wth('Release', worker.index + 1, 'after one');
			releaseWorker(worker);
		}
	};

	// Type definitions for schema-based operations
	type Schema = Record<string, string | { type: string; generated?: string; required?: boolean; unique?: boolean }>;

	type Index<SCHEMA extends Schema> =
		| keyof SCHEMA
		| (keyof SCHEMA)[]
		| ({ unique?: boolean } & (
				| {
						column: keyof SCHEMA;
				  }
				| { columns: (keyof SCHEMA)[] }
		  ));

	type OutputOptions<SCHEMA extends Schema> = {
		indexes?: Index<SCHEMA>[];
		temp?: boolean;
	};

	/**
	 * Creates a bulk write utility for efficiently inserting many rows.
	 * Automatically batches inserts to stay within SQLite variable limits.
	 *
	 * @param table - Table name to insert into
	 * @param keys - Column names for the insert
	 * @returns Object with enqueue() to add rows and close() to flush remaining
	 */
	const bulkWrite = <KEYS extends string>(table: string, keys: KEYS[]) => {
		const SQLITE_MAX_VARS = 32766;
		const maxBufferSize = Math.floor(SQLITE_MAX_VARS / keys.length);

		const buffer: { [K in KEYS]: any }[] = [];

		let writePromise = Promise.resolve<number>(0);

		// Flush buffer to database
		const flush = () => {
			const toInsert = [...buffer];
			buffer.length = 0;
			writePromise = writePromise.then((currentAffected) => {
				return write(
					`INSERT INTO ${table} (${keys.join(',')}) VALUES ${toInsert.map(() => `(${keys.map(() => '?')})`)}`,
					toInsert.flatMap((data) => keys.map((k) => data[k])),
				).then(({ affected: chunkAffected }) => {
					return currentAffected + chunkAffected;
				});
			});
		};
		return {
			// Add a row to the buffer, flushing if buffer is full
			enqueue: (data: { [K in KEYS]: any }) => {
				buffer.push(data);
				if (buffer.length >= maxBufferSize) flush();
			},
			// Flush any remaining rows and return total affected count
			close: () => {
				if (buffer.length) flush();
				return writePromise;
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
	const output = <SCHEMA extends Schema>(table: string, schema: SCHEMA, options?: OutputOptions<SCHEMA>) => {
		const { enqueue, close } = bulkWrite(
			table,
			Object.keys(schema).filter((col) => typeof schema[col] !== 'object' || !schema[col].generated),
		);

		// Normalize schema entries to internal format
		const normalizedSchema = Object.entries(schema).map(([k, v]) => {
			const type = typeof v === 'string' ? v : v.type;
			const unique = typeof v === 'object' && !!v.unique;
			const notnull = typeof v === 'object' && !!v.required;
			const generated = typeof v === 'object' ? v.generated : undefined;
			return { name: k, type, unique, notnull, generated };
		});

		// Drop and recreate table with schema
		const createTablePromise = write(`
			DROP TABLE IF EXISTS ${table}
		`).then(async () => {
			await write(`
				CREATE ${options?.temp ? 'TEMPORARY' : ''} TABLE ${table}(
					${normalizedSchema
						.map(({ name, type, unique, notnull, generated }) => {
							return `${name} ${type} ${unique ? 'UNIQUE' : ''} ${notnull ? 'NOT NULL' : ''} ${generated ? `GENERATED ALWAYS AS ${generated}` : ''}`;
						})
						.join(',')}
				)
			`);
		});

		return {
			// Add a row, waiting for table creation if needed
			enqueue: (data: { [K in keyof SCHEMA as SCHEMA[K] extends { generated: string } ? never : K]: any }) => {
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
								const unique = !Array.isArray(index) && typeof index === 'object' && !!index.unique;
								if (!columns) continue;
								await write(
									`CREATE ${unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS ${table}_${columns.join('_')}_${unique ? 'U' : 'IDX'} ON ${table}(${columns.join(',')})`,
								);
							}
						}
						return affected;
					});
			},
		};
	};

	// Transaction API type with commit/rollback methods
	type TransactionDB = SQLiteDB & {
		commit: () => Promise<void>;
		rollback: () => Promise<void>;
	};

	/**
	 * Executes a callback within a database transaction.
	 * Provides commit/rollback methods and can auto-commit on success.
	 *
	 * @param callback - Function to execute within transaction, receives TransactionDB
	 * @param options - readOnly flag and autoCommit behavior
	 * @returns Result of callback function
	 */
	const transaction = async <T = void>(
		callback: (db: TransactionDB) => Promise<T>,
		options?: { readOnly?: boolean; autoCommit?: boolean },
	) => {
		const { readOnly = false, autoCommit = true } = options ?? {};
		const worker = await getNextAvailableWorker(!readOnly);

		// Validate that read-only transactions don't attempt writes
		const checksql = (sql: string) => {
			if (readOnly && isWriteQuery(sql)) throw new Error('Cannot werite in read-only transaction');
			return sql;
		};

		let done = false;

		// Create TransactionDB with scoped methods
		const db: TransactionDB = {
			read: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: any[]) =>
				readWorker<T>(worker, checksql(sql), ...args),
			write: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: any[]) =>
				writeWorker<T>(worker, checksql(sql), ...args),
			stream: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: any[]) =>
				streamWorker<T>(worker, checksql(sql), ...args),
			one: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...args: any[]) =>
				oneWorker<T>(worker, checksql(sql), ...args),
			commit: async () => {
				done = true;
				await oneWorker(worker, 'COMMIT');
			},
			rollback: async () => {
				done = true;
				await oneWorker(worker, 'ROLLBACK');
			},
		};

		try {
			// Start transaction
			await db.read('BEGIN');
			const result = await callback(db);

			// Auto-commit if not manually committed/rolled back
			if (!done) {
				if (autoCommit) {
					await db.commit();
				} else {
					await db.rollback();
				}
			}
			return result;
		} catch (e) {
			// Rollback on error
			await db.rollback();
			throw e;
		} finally {
			// Always release worker back to pool
			releaseWorker(worker);
		}
	};

	/**
	 * Terminates all workers and cleans up the pool.
	 */
	const close = () => {
		let worker: (typeof pool)[number] | undefined;
		while ((worker = pool.shift())) worker.terminate();
	};

	// Initialize the worker pool with the requested number of workers
	Promise.all(
		Array.from({ length: poolSize }).map(() =>
			createWorker().then((worker) => {
				// releaseWorker(worker);
				return worker;
			}),
		),
	)
		.then((allWorkers: PoolWorker[]) => {
			for (const worker of allWorkers) {
				releaseWorker(worker);
			}
			LL.success('SQLite worker pool initialized');
			// for (const worker of pool) releaseWorker(worker);
		})
		.catch((e) => LL.error('Error initializing SQLite worker pool:', e));

	// Return the public API
	const api = {
		read,
		write,
		stream,
		one,
		transaction,
		bulkWrite,
		output,
		close,

		debug,
	};
	return api;
}) satisfies (...args: any[]) => SQLiteDB;
