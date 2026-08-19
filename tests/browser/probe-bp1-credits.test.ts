import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

/**
 * BP-1 CREDIT/ACK VALIDATION — measurement, not a test. Throwaway scaffolding.
 *
 * The design under test: the worker awaits one credit MESSAGE per chunk, and
 * the client keeps a window of credits outstanding. The claim is that this one
 * mechanism yields three properties at once — bounded memory, no stall, and a
 * mid-query abort delivered within one chunk — because awaiting a message costs
 * exactly one task turn even when the message is already queued.
 *
 * The first probe (commit dc96f57) established that no task turn happens on its
 * own during a query. It did NOT establish that creating one restores delivery.
 * That is what this measures.
 *
 * M1 — 'await' mode: a mid-query abort is handled, within one chunk.
 * M2 — 'counter' mode with batched credits: it is handled `n` chunks late.
 *      Without this the implementation condition is unfalsifiable — "await the
 *      message, do not test a counter" would be a comment nobody can check.
 * M3 — throughput against window size, and against no back-pressure at all.
 *      This is the argument against strict lockstep; if window 2 does not
 *      recover the round-trip, lockstep is no worse and is simpler.
 *
 * The probe drives the worker directly. The pool ignores the traffic: with no
 * query of its own in flight, `deferredChunk` is undefined and every chunk and
 * done it sees is dropped.
 */

const ROWS = 200_000;
const CHUNK_SIZE = 50; // 4000 chunks — a per-chunk round-trip has to show here
const ABORT_AFTER_CHUNKS = 50;

type Run = {
  label: string;
  mode: 'none' | 'await' | 'counter';
  /** Credits outstanding. Also credits per message in 'counter' mode. */
  window: number;
  durationMs: number;
  chunksSent: number;
  /** Chunks already sent when the worker HANDLED the abort. */
  abortSeenAtChunk: number | undefined;
  /** Chunks between posting the abort and the worker handling it. */
  abortLatencyChunks: number | undefined;
};

const runs: Run[] = [];

describe('BP-1 — does awaiting a credit message buy the task turn?', () => {
  it('measures', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.read('SELECT 1 AS n');
    const worker = records[0].worker;

    await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)');
    await db.write(
      `INSERT INTO t(data) SELECT hex(randomblob(8)) FROM (
         WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${ROWS})
         SELECT x FROM c)`,
    );

    let callId = 1000;

    const run = (
      label: string,
      mode: 'none' | 'await' | 'counter',
      window: number,
    ) =>
      new Promise<Run>((resolve) => {
        callId += 1;
        const myCallId = callId;
        let received = 0;
        let abortPostedAtChunk: number | undefined;
        const started = performance.now();

        const onMessage = (event: MessageEvent) => {
          const data = event.data as {
            type: string;
            callId: number;
            probe?: { chunksSent: number; abortSeenAtChunk?: number };
          };
          if (data?.callId !== myCallId) return;

          if (data.type === 'chunk') {
            received += 1;

            // Stand-in for an abort arriving mid-query.
            if (received === ABORT_AFTER_CHUNKS) {
              abortPostedAtChunk = received;
              worker.postMessage({
                type: 'probe-abort',
                postedAt: performance.now(),
              });
            }

            // Replenish: one credit per chunk consumed, keeping the window
            // full. 'counter' mode batches them, which is the whole point.
            if (mode === 'await') {
              worker.postMessage({ type: 'credit', n: 1 });
            } else if (mode === 'counter' && received % window === 0) {
              worker.postMessage({ type: 'credit', n: window });
            }
          }

          if (data.type === 'done') {
            worker.removeEventListener('message', onMessage);
            const seen = data.probe?.abortSeenAtChunk;
            resolve({
              label,
              mode,
              window,
              durationMs: Math.round(performance.now() - started),
              chunksSent: data.probe?.chunksSent ?? received,
              abortSeenAtChunk: seen,
              abortLatencyChunks:
                seen === undefined || abortPostedAtChunk === undefined
                  ? undefined
                  : seen - abortPostedAtChunk,
            });
          }
        };
        worker.addEventListener('message', onMessage);

        // Order matters: the query first, then the credits. The worker cannot
        // dispatch either until it awaits something, and its first await is the
        // credit for chunk 1 — so the credits are waiting in the queue by then
        // and it never stalls.
        worker.postMessage({
          type: 'query',
          callId: myCallId,
          sql: 'SELECT id FROM t',
          params: [],
          options: { chunkSize: CHUNK_SIZE, probe: { mode } },
        });
        if (mode === 'await') {
          for (let i = 0; i < window; i += 1) {
            worker.postMessage({ type: 'credit', n: 1 });
          }
        } else if (mode === 'counter') {
          worker.postMessage({ type: 'credit', n: window });
        }
      });

    const plan: [string, 'none' | 'await' | 'counter', number][] = [
      ['baseline, no back-pressure', 'none', 0],
      ['tick+credit, window 1', 'await', 1],
      ['tick+credit, window 2', 'await', 2],
      ['tick+credit, window 4', 'await', 4],
      ['tick+credit, window 16', 'await', 16],
      ['counter only, batches of 16', 'counter', 16],
    ];

    // Three passes: one run cannot separate a small per-chunk cost from noise.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [label, mode, window] of plan) {
        runs.push(await run(`${label} #${pass + 1}`, mode, window));
        await sleep(50);
      }
    }

    await db.close();
    expect(runs).toHaveLength(plan.length * 3);
  }, 180_000);

  // Deliberately red: browser console output is not forwarded to the terminal,
  // so the failure message is the probe's only reporting channel.
  it('reports', () => {
    throw new Error(`PROBE-BP1-CREDITS ${JSON.stringify(runs)}`);
  });
});
