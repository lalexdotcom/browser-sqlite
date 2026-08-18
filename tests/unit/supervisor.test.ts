// tests/unit/supervisor.test.ts
import { describe, expect, it } from '@rstest/core';
import { createSupervisor } from '../../src/supervisor';

describe('supervisor — R1: a slot that never reported ready is never restarted', () => {
  // Falsifiable: delete the `if (!slot.everReady) return evict(...)` branch.
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
