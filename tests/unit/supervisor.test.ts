// tests/unit/supervisor.test.ts
import { describe, expect, it } from '@rstest/core';
import { createSupervisor } from '../../src/supervisor';

describe('supervisor — R1: a slot that never reported ready is never restarted', () => {
  // Falsifiable: remove `slot.everReady &&` from the restart guard — a
  // never-ready slot then returns 'restart' instead of 'lost'.
  it('loses a slot that dies before its first ready', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('lost');
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
    expect(supervisor.report(0, 'died')).toBe('lost');
  });

  it('defaults to a single restart', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('lost');
  });
});

describe('supervisor — R5: the last slot', () => {
  // Falsifiable: delete the live-count check that upgrades 'lost' to 'fail-client'.
  it('fails the client when losing a slot leaves no live slot', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('lost');
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
    expect(supervisor.report(0, 'died')).toBe('lost'); // budget exhausted, not restart
  });
});

describe('supervisor — late ready after a slot is lost', () => {
  // Falsifiable: remove the `if (slot.lost) return undefined` guard from
  // the 'ready' branch — the slot is resurrected, inflates liveCount, and
  // the last live slot's death returns 'lost' instead of 'fail-client'.
  it('does not revive a lost slot when ready arrives late', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('lost'); // R1: never ready → lost
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

  // Falsifiable: drop the `slot.lost` check from the 'spawned' branch — a
  // lost slot is revived, liveCount inflates, and the last live slot's
  // death returns 'lost' instead of 'fail-client'.
  it('does not revive a lost slot', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('lost'); // never ready → lost
    supervisor.report(0, 'spawned');
    expect(supervisor.report(1, 'died')).toBe('fail-client');
  });
});

describe('supervisor — post-startup R1 is unchanged by the deferred-verdict design', () => {
  // The startup deferred verdict (onFirstSettle in the scheduler / client) does
  // not alter the supervisor's state machine.  These tests confirm that the
  // supervisor behaves identically regardless of whether the client treated a
  // death as a startup failure or a post-startup crash.

  // Falsifiable: accidentally reset slot.everReady or slot.restarts in the
  // supervisor when the client calls report(index, 'died') for a post-startup
  // crash — the restart decision would then be wrong.
  it('restarts a slot that was ready, died, and then reports ready again post-startup', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart'); // still R1: restart
  });

  // Falsifiable: remove the liveCount guard so 'lost' is returned even when
  // pool is non-empty — the client would not fail, but it should.
  it('fails the client when the last live slot is lost post-startup', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 0 });
    // Slot 1 already opened and is alive.
    supervisor.report(1, 'ready');
    // Slot 0 dies without ever being ready → lost.
    expect(supervisor.report(0, 'died')).toBe('lost'); // slot 1 still alive
    // Now slot 1 dies beyond its budget → fail-client.
    expect(supervisor.report(1, 'died')).toBe('fail-client');
  });
});

describe("supervisor — 'lost' is a terminal death, not a restartable one", () => {
  // The startup retry round is capped at one round, so a slot the client has
  // already announced through `onWorkerLost` must never come back. Reporting it
  // as 'died' left `slot.lost` false — the client's view (permanently lost) and
  // the supervisor's (dead, restartable) then disagreed, and any future pool
  // healing would have revived a slot the consumer was told was gone.
  //
  // Falsifiable: drop `slot.lost = true` from the 'lost' branch. The revival
  // below then succeeds, liveCount() is 1 when slot 1 dies, and the last
  // expectation reads 'lost' instead of 'fail-client'.
  it('cannot be revived by a later spawned/ready', () => {
    // maxWorkerRestarts 1, NOT 0: with a spent budget the plain 'died' path
    // already marks the slot lost, so the test would pass against the very
    // code it is meant to falsify. The budget has to be intact for 'lost' and
    // 'died' to differ at all.
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    supervisor.report(1, 'ready');

    // Terminal: 'died' here would return 'restart' and leave the slot revivable.
    expect(supervisor.report(0, 'lost')).toBe('lost');

    // The revival attempt a future pool-healing feature would make.
    supervisor.report(0, 'spawned');
    supervisor.report(0, 'ready');

    // Slot 1 now burns its own budget. If slot 0 had come back, the last death
    // would find it alive and return 'lost' instead of emptying the pool.
    expect(supervisor.report(1, 'died')).toBe('restart');
    supervisor.report(1, 'ready');
    expect(supervisor.report(1, 'died')).toBe('fail-client');
  });

  // Falsifiable: return 'lost' unconditionally from the 'lost' branch instead
  // of consulting liveCount() — this then reads 'lost' and the client never
  // fails, which is the hang this whole branch exists to prevent.
  it('fails the client when the slot it loses was the last live one', () => {
    const supervisor = createSupervisor({ size: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'lost')).toBe('fail-client');
  });

  // Falsifiable: remove the `if (!slot.alive) return undefined` guard from the
  // 'lost' branch — the repeat then returns a second decision, and the client
  // would emit onWorkerLost twice for one slot.
  it('reports once per slot, like a death', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'lost')).toBe('lost');
    expect(supervisor.report(0, 'lost')).toBeUndefined();
  });
});
