import { Logger } from '@lalex/console';
// @ts-expect-error
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
// @ts-expect-error
import { SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
import { WorkerOrchestrator, WorkerStatuses } from './orchestrator';
import type { ClientMessageData, SQLiteVFS, WorkerMessageData } from './types';

type SQLOptions = { chunkSize?: number; signal?: AbortSignal };

const LL = Logger.scope('sqlite/worker');
LL.level = 'debug';
LL.date = LL.level === 'debug';

/**
 * SQLite Web Worker entry point.
 *
 * This module runs inside each worker thread spawned by `createSQLiteClient`.
 * It handles two message types from the client:
 *
 * - `open`  — initializes the wa-sqlite WASM module, registers the VFS, acquires
 *              the initialization lock (`orchestrator.lock()`) to serialize DB
 *              open across the pool, opens the database, then releases the lock
 *              (`orchestrator.unlock()`) and posts `{ type: 'ready' }`.
 *              After `open` completes, `self.onmessage` is replaced with the
 *              query handler so subsequent messages are processed as queries.
 *
 * - `query` — executes a SQL statement via an async generator, streaming rows
 *              back as `{ type: 'chunk' }` messages and finishing with
 *              `{ type: 'done', affected }` or `{ type: 'error' }`.
 *
 * State transitions driven by this module:
 *   INITIALIZING → (lock acquired) → INITIALIZED → READY  (inside open())
 *   READY → RUNNING                                        (start of query handler)
 *   RUNNING → ABORTING                                     (AbortSignal fires, set by client.ts)
 *   RUNNING | ABORTING → DONE                              (query finally block)
 */

const WA_SQLITE_MODULES = {
	// @ts-expect-error
	wa_sqlite: () => import(/* webpackChunkName: "wa-sqlite" */ 'wa-sqlite/dist/wa-sqlite.mjs'),
	// @ts-expect-error
	wa_sqlite_async: () => import(/* webpackChunkName: "wa-sqlite-async" */ 'wa-sqlite/dist/wa-sqlite-async.mjs'),
	// @ts-expect-error
	wa_sqlite_jspi: () => import(/* webpackChunkName: "wa-sqlite-jspi" */ 'wa-sqlite/dist/wa-sqlite-jspi.mjs'),
};

const VFSConfigs = {
	OPFSPermutedVFS: {
		// @ts-expect-error
		fs: () => import(/* webpackChunkName: "OPFSPermutedVFS" */ 'wa-sqlite/src/examples/OPFSPermutedVFS.js'),
		module: WA_SQLITE_MODULES.wa_sqlite_async,
	},
	OPFSAdaptiveVFS: {
		// @ts-expect-error
		fs: () => import(/* webpackChunkName: "OPFSAdaptiveVFS" */ 'wa-sqlite/src/examples/OPFSAdaptiveVFS.js'),
		module: WA_SQLITE_MODULES.wa_sqlite_jspi,
	},
	OPFSCoopSyncVFS: {
		// @ts-expect-error
		fs: () => import(/* webpackChunkName: "OPFSCoopSyncVFS" */ 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js'),
		module: WA_SQLITE_MODULES.wa_sqlite,
	},
	AccessHandlePoolVFS: {
		// @ts-expect-error
		fs: () => import(/* webpackChunkName: "AccessHandlePoolVFS" */ 'wa-sqlite/src/examples/AccessHandlePoolVFS.js'),
		module: WA_SQLITE_MODULES.wa_sqlite,
	},
	IDBBatchAtomicVFS: {
		// @ts-expect-error
		fs: () => import(/* webpackChunkName: "IDBBatchAtomicVFS" */ 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js'),
		module: WA_SQLITE_MODULES.wa_sqlite_async,
	},
} as const satisfies Record<SQLiteVFS, { name?: string; fs: () => Promise<any>; module: () => Promise<any> }>;

let orchestrator: WorkerOrchestrator;
let openedDB: Promise<{ sqlite: any; db: any }> | undefined;

// let log = (...args: Parameters<typeof console.log>) => {
// 	LL.wth(...args);
// };

type OpenOptions = {
	vfs?: SQLiteVFS;
	pragmas?: Record<string, string>;
};

/**
 * Called once per worker thread when the client sends the `open` message.
 * Loads the wa-sqlite WASM module and VFS, acquires the orchestrator initialization
 * lock to prevent parallel DB opens across the pool, opens the SQLite database,
 * then transitions this worker to READY and replaces the top-level message handler
 * with the query handler.
 *
 * @param file - Database file name passed from `createSQLiteClient`.
 * @param flags - SharedArrayBuffer from the orchestrator, used to construct
 *   a worker-side `WorkerOrchestrator` view for status and lock operations.
 * @param index - This worker's index in the pool (0-based).
 * @param options - VFS selection and PRAGMA map.
 */
const open = (file: string, flags: SharedArrayBuffer, index: number, options?: OpenOptions) => {
	// log = (...args: Parameters<typeof console.log>) => {
	// 	LL.debug(`Worker ${index + 1}`, ...args);
	// };

	LL.debug(`[Worker ${index + 1}] open() called with file:`, file);
	if (openedDB) {
		LL.error(`[Worker ${index + 1}] Error: DB already opened`);
		throw new Error('DB already opened');
	}

	orchestrator = new WorkerOrchestrator(flags);

	const { vfs = 'OPFSCoopSyncVFS', pragmas = {} } = options ?? {};

	const allQueryPragmas = Object.keys(pragmas).length
		? ''
		: Object.entries(pragmas)
				.map(([key, val]) => `PRAGMA ${key}=${val};`)
				.join('');

	const vfsConfig = VFSConfigs[vfs];

	LL.debug(`[Worker ${index + 1}] Open ${file} using VFS:`, vfs);

	openedDB = vfsConfig
		.module()
		.then(({ default: factory }) => factory())
		.then((module) => {
			LL.verb(`[Worker ${index + 1}] SQLite module loaded`);
			const sqlite = SQLite.Factory(module);
			return vfsConfig.fs().then((vfsModule) => ({ sqlite, module, vfsModule: vfsModule[vfs] }));
		})
		.then(({ sqlite, module, vfsModule }) => {
			LL.verb(`[Worker ${index + 1}] VFS module loaded:`, vfs);
			return (vfsModule.create(vfs, module, { lockPolicy: 'shared' }) as Promise<any>).then((vfsInstance: any) => {
				LL.verb(`[Worker ${index + 1}] VFS instance created`);
				sqlite.vfs_register(vfsInstance, true);

				LL.debug(`[Worker ${index + 1}] Acquiring initLock to open DB`);
				orchestrator.lock();
				LL.debug(`[Worker ${index + 1}] initLock acquired, opening DB now`);
				const openTime = Date.now();
				return sqlite.open_v2(file).then((db: any) => {
					LL.debug(`[Worker ${index + 1}] Database ${file} opened in`, Date.now() - openTime, 'ms');
					return { sqlite, db };
				});
			});
		})
		.catch((e) => {
			LL.warn(`[Worker ${index + 1}] Error during open:`, e);
			throw e;
		})
		.finally(() => {
			LL.debug(`[Worker ${index + 1}] Releasing initLock after open`);
			orchestrator.unlock();
			LL.debug(`[Worker ${index + 1}] Database opened and ready`);
			// Transition: INITIALIZING → READY
			// Marks this worker as available for queries. The client's releaseWorker()
			// observes READY status and dispatches queued requests to this worker.
			orchestrator.setStatus(index, WorkerStatuses.READY);
			self.postMessage({ type: 'ready', callId: 0 });
		});

	const reply = (data: WorkerMessageData) => {
		self.postMessage(data);
	};

	const query = async function* (sql: string, params: unknown[], options?: SQLOptions) {
		if (!openedDB) throw new Error('No DB opened');

		const { sqlite, db } = await openedDB;
		const { chunkSize = 1 } = options ?? {};

		const buffer = [];

		for await (const stmt of sqlite.statements(db, `${allQueryPragmas}${sql}`)) {
			if (params?.length) {
				sqlite.bind_collection(stmt, params);
			}
			const cols = sqlite.column_names(stmt) as string[];

			while (true) {
				// Abort check: if client set status to ABORTING (via AbortSignal),
				// stop processing rows and exit the loop. The query generator yields
				// the final sqlite.changes() value, then the handler posts 'done'.
				if (orchestrator.getStatus(index) === WorkerStatuses.ABORTING) break;

				const result = await sqlite.step(stmt);
				if (orchestrator.getStatus(index) === WorkerStatuses.ABORTING) break;

				if (result === SQLITE_ROW) {
					const row = sqlite.row(stmt);
					const rowObject = Object.fromEntries(cols.map((key, i) => [key, row[i]]));
					buffer.push(rowObject);

					if (buffer.length >= chunkSize) {
						yield buffer.splice(0, chunkSize);
					}
				} else {
					while (buffer.length) {
						yield buffer.splice(0, chunkSize);
					}
					break;
				}
			}
		}
		yield sqlite.changes(db);
	};

	self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
		LL.verb(`[Worker ${index + 1}] Query handler - received message:`, event.data.type);
		const { data } = event;
		if (data.type === 'query') {
			const { callId, sql, params, options } = data;
			try {
				// Transition: READY → RUNNING
				// Signals to the client that this worker is busy. The client may set
				// status to ABORTING via AbortSignal while the worker is RUNNING.
				orchestrator.setStatus(index, WorkerStatuses.RUNNING);
				LL.wth(`[Worker ${index + 1}] Executing query:`, sql);
				let affected = 0;

				for await (const chunk of query(sql, params, options)) {
					if (typeof chunk === 'number') {
						LL.wth(`[Worker ${index + 1}] Sending chunk for`, chunk, 'affected rows');
						affected = chunk;
						break;
					} else {
						LL.wth(`[Worker ${index + 1}] Sending chunk with`, chunk.length, 'rows');
						reply({ type: 'chunk', callId, data: chunk });
					}
				}

				LL.verb(`[Worker ${index + 1}] Query completed, affected:`, affected);
				reply({ type: 'done', callId, affected });
			} catch (e) {
				LL.warn(`[Worker ${index + 1}] Query error:`, e);
				reply({
					type: 'error',
					callId,
					...(typeof e === 'object'
						? e instanceof Error
							? { message: e.message, cause: e.cause }
							: { message: 'Unknown error', cause: e }
						: { message: `Unknown error (${e})` }),
				});
			} finally {
				// Transition: RUNNING | ABORTING → DONE
				// Marks query as finished. The client's releaseWorker() will observe DONE
				// (or READY if setStatus was already called) and either dispatch a queued
				// request or set status back to READY.
				orchestrator.setStatus(index, WorkerStatuses.DONE);
			}
		}
	};
};

// Top-level message handler: processes only 'open' messages.
// After open() is called, this handler is replaced by the query handler
// defined inside open(), which processes subsequent 'query' messages.
self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
	const { data } = event;
	if (data.type === 'open') {
		const { file, flags, index, vfs, pragmas } = data;
		open(file, flags, index, { vfs, pragmas });
	}
};
