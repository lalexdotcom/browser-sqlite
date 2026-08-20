import { describe, expect, it } from '@rstest/core';
import type { SQLiteVFS } from '../../src/types';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  sleep,
} from './helpers';

/**
 * BP-1 PROBE — measurement, not a test. Throwaway scaffolding for wave 4.
 *
 * The question (mem:follow-ups BP-1, mem:resume-plan §1.5): is a `postMessage`
 * sent to a worker delivered while that worker is inside a query?
 *
 * §1.5 asserts it is not. That was reasoned, never observed, and it is
 * certainly true only of the synchronous wa-sqlite build. The default VFS
 * `OPFSPermutedVFS` runs the Asyncify build, which unwinds the WASM stack
 * around every asynchronous VFS call — so a message may well be delivered
 * between two page reads.
 *
 * Four combinations: {CPU-bound, I/O-bound} × {async VFS, sync VFS}.
 *
 * - CPU-bound: a recursive CTE with no table. One long `sqlite.step()`, no VFS
 *   traffic once the schema pages are cached.
 * - I/O-bound: a full scan of a table far larger than the page cache
 *   (`cache_size` is pinned to 10 pages), so nearly every row costs a VFS read.
 *
 * Results are reported by round-trip on the MAIN thread's clock — worker and
 * window do not share a time origin, so a cross-thread subtraction would be
 * meaningless. What the worker reports is the one thing only it can know:
 * whether a query was in flight when the handler actually ran.
 */

type Pong = {
  type: 'pong';
  callId: number;
  postedAt: number;
  handledAt: number;
  inQuery: boolean;
};

type ProbeResult = {
  vfs: SQLiteVFS;
  load: 'cpu' | 'io';
  /**
   * Positive control. A ping sent while the worker is idle MUST come back. If
   * this is false the whole row is void: it measures a broken channel, not a
   * blocked one.
   */
  channelOk: boolean;
  queryMs: number;
  pingsSent: number;
  handledInQuery: number;
  /**
   * Second control. Pings handled once the query has finished — this is what
   * "the message was queued, not lost" looks like. Zero here alongside zero
   * `handledInQuery` means the pings never reached the worker at all.
   */
  handledLate: number;
  roundTripMs: number[];
  /** Set when the VFS could not run here at all (e.g. no JSPI support). */
  unavailable?: string;
};

const report: ProbeResult[] = [];

const PING_INTERVAL_MS = 25;
const IO_ROWS = 60_000;
const CPU_ITERATIONS = 20_000_000;

async function probe(vfs: SQLiteVFS, load: 'cpu' | 'io'): Promise<ProbeResult> {
  const records = interceptWorkers();
  const db = await createTestClient({
    poolSize: 1,
    vfs,
    // 10 pages of cache: a scan of the table below cannot be served from
    // memory, so the I/O-bound case really does hit the VFS.
    pragmas: { cache_size: '10' },
  });

  // Forces the worker to exist and reach READY before anything is measured.
  await db.read('SELECT 1 AS n');
  const worker = records[0].worker;

  let sql: string;
  if (load === 'io') {
    await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)');
    await db.write(
      `INSERT INTO t(data) SELECT hex(randomblob(200)) FROM (
         WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${IO_ROWS})
         SELECT x FROM c)`,
    );
    sql = "SELECT count(*) AS n FROM t WHERE data LIKE '%zzzzzzzz%'";
  } else {
    sql = longQuery(CPU_ITERATIONS);
  }

  const sentAt = new Map<number, number>();
  const pongs: (Pong & { receivedAt: number })[] = [];
  worker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Pong;
    if (data?.type === 'pong') {
      pongs.push({ ...data, receivedAt: performance.now() });
    }
  });

  let callId = 0;

  // Positive control, worker idle: does a ping come back at all?
  callId += 1;
  sentAt.set(callId, performance.now());
  worker.postMessage({ type: 'ping', callId, postedAt: performance.now() });
  await sleep(200);
  const channelOk = pongs.length > 0;
  pongs.length = 0;

  let running = true;
  const pinger = setInterval(() => {
    if (!running) return;
    callId += 1;
    const postedAt = performance.now();
    sentAt.set(callId, postedAt);
    worker.postMessage({ type: 'ping', callId, postedAt });
  }, PING_INTERVAL_MS);

  const started = performance.now();
  await db.read(sql);
  const queryMs = performance.now() - started;
  running = false;
  clearInterval(pinger);

  // Give any message the worker only queued a chance to be handled now that it
  // is idle again. Without this wait the snapshot is taken too early and a
  // queued ping is indistinguishable from a lost one.
  const inQuery = pongs.filter((pong) => pong.inQuery);
  await sleep(500);

  const result: ProbeResult = {
    vfs,
    load,
    channelOk,
    queryMs: Math.round(queryMs),
    pingsSent: callId,
    handledInQuery: inQuery.length,
    handledLate: pongs.filter((pong) => !pong.inQuery).length,
    roundTripMs: inQuery.map((pong) =>
      Math.round(pong.receivedAt - (sentAt.get(pong.callId) ?? 0)),
    ),
  };
  report.push(result);
  await db.close();
  return result;
}

describe('BP-1 probe — is a postMessage delivered during a query?', () => {
  // The axis that can actually differ is the WASM build's suspension
  // mechanism, not the VFS: OPFSPermutedVFS is Asyncify, OPFSCoopSyncVFS is the
  // synchronous build, and OPFSAdaptiveVFS is JSPI — which suspends by
  // integrating with real promises rather than unwinding to a JS trampoline,
  // and is therefore the one that could plausibly yield on its own.
  const combinations: { vfs: SQLiteVFS; load: 'cpu' | 'io' }[] = [
    { vfs: 'OPFSPermutedVFS', load: 'cpu' },
    { vfs: 'OPFSPermutedVFS', load: 'io' },
    { vfs: 'OPFSCoopSyncVFS', load: 'cpu' },
    { vfs: 'OPFSCoopSyncVFS', load: 'io' },
    { vfs: 'OPFSAdaptiveVFS', load: 'cpu' },
    { vfs: 'OPFSAdaptiveVFS', load: 'io' },
  ];

  for (const { vfs, load } of combinations) {
    it(`${vfs} / ${load}-bound`, async () => {
      // JSPI may simply not be available in the pinned Chromium. "Unmeasurable
      // here" is a legitimate outcome and must be recorded as such, not hidden
      // behind a red test.
      let result: ProbeResult;
      try {
        result = await probe(vfs, load);
      } catch (error) {
        report.push({
          vfs,
          load,
          channelOk: false,
          queryMs: -1,
          pingsSent: 0,
          handledInQuery: -1,
          handledLate: -1,
          roundTripMs: [],
          unavailable: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // The probe must not be shorter than the ping interval, or it measures
      // nothing. This is the only real assertion here.
      expect(result.queryMs).toBeGreaterThan(PING_INTERVAL_MS * 10);
    }, 120_000);
  }

  // Deliberately red: browser console output is not forwarded to the terminal,
  // so the failure message is the probe's only reporting channel.
  it('reports', () => {
    expect(report).toHaveLength(6);
    throw new Error(`PROBE-BP1-REPORT ${JSON.stringify(report)}`);
  });
});
