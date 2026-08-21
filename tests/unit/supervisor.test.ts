// tests/unit/supervisor.test.ts
import { describe, expect, it } from '@rstest/core';
import { createSupervisor } from '../../src/supervisor';

describe('supervisor — R1: a slot that never reported ready is never restarted', () => {
  // Falsifiable: remove `slot.everReady &&` from the restart guard — a
  // never-ready slot then returns 'restart' instead of 'evict'.
  it('evicts a slot that dies before its first ready', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('evict');
  });
});

describe('supervisor — R2: the counter resets on a served request, not on ready', () => {
  // THE decisive test. Falsifiable: move the counter reset from the 'served'
  // branch to the 'ready' branch and this loops instead of stopping.
  it('stops a slot that boots fine and dies on every request', () => {
    const supervisor = createSupervisor({ size: 1, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('fail-client');
  });

  it('gives a slot its budget back once it has actually served something', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    supervisor.report(0, 'served');
    expect(supervisor.report(0, 'died')).toBe('restart');
  });
});

describe('supervisor — R3/R4: the bound', () => {
  it('honours maxWorkerRestarts', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('evict');
  });

  it('defaults to a single restart', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('evict');
  });
});

describe('supervisor — R5: the last slot', () => {
  // Falsifiable: delete the live-count check that upgrades 'evict' to 'fail-client'.
  it('fails the client when eviction leaves no live slot', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('evict');
    expect(supervisor.report(1, 'died')).toBe('fail-client');
  });

  it('does not fail the client while a restart is pending', () => {
    const supervisor = createSupervisor({ size: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
  });
});

describe('supervisor — a second death report on the same slot', () => {
  // Falsifiable: delete the `if (!slot.alive) return undefined` guard — a
  // duplicate report then burns a restart, and onerror plus a drain timeout on
  // the same worker is an ordinary double report.
  it('is ignored', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    expect(supervisor.report(0, 'died')).toBeUndefined();
  });
});

describe('supervisor — stale served on a dead slot', () => {
  // Falsifiable: remove the `if (!slot.alive) return undefined` guard from
  // the 'served' branch — the stale done message then resets restarts to 0
  // on the dead slot, silently refilling the spent restart budget.
  it('does not reset the restart budget when served arrives after died', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart'); // restarts = 1
    // stale done message arrives after the slot was declared dead
    supervisor.report(0, 'served'); // must not reset restarts
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('evict'); // budget exhausted, not restart
  });
});

describe('supervisor — late ready after eviction', () => {
  // Falsifiable: remove the `if (slot.evicted) return undefined` guard from
  // the 'ready' branch — the slot is resurrected, inflates liveCount, and
  // the last live slot's death returns 'evict' instead of 'fail-client'.
  it('does not revive an evicted slot when ready arrives late', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('evict'); // R1: never ready → evict
    supervisor.report(0, 'ready'); // late ready must be ignored
    expect(supervisor.report(1, 'died')).toBe('fail-client'); // only live slot dies
  });
});

describe('supervisor — the replacement dies before it is ready', () => {
  // Falsifiable: delete the `event === 'spawned'` branch. The slot stays
  // marked dead from the first death, the replacement's death is taken for a
  // duplicate signal, and the decision is undefined — on which the client acts
  // not at all: no restart, no shutdown, and every queued request waits for a
  // worker that will never come.
  it('fails the client instead of returning no decision', () => {
    const supervisor = createSupervisor({ size: 1, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'spawned'); // the client relaunches the slot
    expect(supervisor.report(0, 'died')).toBe('fail-client');
  });

  // The guard this must not trade away: within one spawn, onerror and a drain
  // timeout are an ordinary double report and must stay ignored.
  it('still ignores a second death report within the same spawn', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    expect(supervisor.report(0, 'died')).toBeUndefined();
  });

  // Falsifiable: drop the `slot.evicted` check from the 'spawned' branch — an
  // evicted slot is revived, liveCount inflates, and the last live slot's
  // death returns 'evict' instead of 'fail-client'.
  it('does not revive an evicted slot', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('evict'); // never ready → evict
    supervisor.report(0, 'spawned');
    expect(supervisor.report(1, 'died')).toBe('fail-client');
  });
});
