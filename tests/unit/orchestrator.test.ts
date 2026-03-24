import { describe, it, expect } from '@rstest/core';
import { WorkerOrchestrator, WorkerStatuses } from '../../src/orchestrator';

describe('WorkerOrchestrator', () => {
  describe('initial state', () => {
    it('all worker slots start as EMPTY', () => {
      const orch = new WorkerOrchestrator(3);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.EMPTY);
      expect(orch.getStatus(1)).toBe(WorkerStatuses.EMPTY);
      expect(orch.getStatus(2)).toBe(WorkerStatuses.EMPTY);
    });

    it('size matches constructor argument', () => {
      const orch = new WorkerOrchestrator(4);
      expect(orch.size).toBe(4);
    });
  });

  describe('getStatus', () => {
    it('returns independent status per worker index', () => {
      const orch = new WorkerOrchestrator(2);
      orch.setStatus(0, WorkerStatuses.READY);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.READY);
      expect(orch.getStatus(1)).toBe(WorkerStatuses.EMPTY);
    });
  });

  describe('setStatus — unconditional exchange', () => {
    it('returns true when status changes', () => {
      const orch = new WorkerOrchestrator(1);
      const result = orch.setStatus(0, WorkerStatuses.READY);
      expect(result).toBe(true);
    });

    it('updates status correctly', () => {
      const orch = new WorkerOrchestrator(1);
      orch.setStatus(0, WorkerStatuses.READY);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.READY);
    });

    it('returns false when setting same status again (no change)', () => {
      const orch = new WorkerOrchestrator(1);
      orch.setStatus(0, WorkerStatuses.READY);
      const result = orch.setStatus(0, WorkerStatuses.READY);
      expect(result).toBe(false);
    });

    it('allows status transitions through lifecycle', () => {
      const orch = new WorkerOrchestrator(1);
      expect(orch.setStatus(0, WorkerStatuses.NEW)).toBe(true);
      expect(orch.setStatus(0, WorkerStatuses.INITIALIZING)).toBe(true);
      expect(orch.setStatus(0, WorkerStatuses.READY)).toBe(true);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.READY);
    });
  });

  describe('setStatus — CAS (conditional with from)', () => {
    it('returns true and updates when from matches current status', () => {
      const orch = new WorkerOrchestrator(1);
      const result = orch.setStatus(0, WorkerStatuses.NEW, WorkerStatuses.EMPTY);
      expect(result).toBe(true);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.NEW);
    });

    it('returns false and leaves status unchanged when from does not match', () => {
      const orch = new WorkerOrchestrator(1);
      // Current status is EMPTY, from=NEW — mismatch
      const result = orch.setStatus(0, WorkerStatuses.READY, WorkerStatuses.NEW);
      expect(result).toBe(false);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.EMPTY);
    });

    it('CAS chain: EMPTY → NEW → READY succeeds in sequence', () => {
      const orch = new WorkerOrchestrator(1);
      expect(orch.setStatus(0, WorkerStatuses.NEW, WorkerStatuses.EMPTY)).toBe(true);
      expect(orch.setStatus(0, WorkerStatuses.READY, WorkerStatuses.NEW)).toBe(true);
      expect(orch.getStatus(0)).toBe(WorkerStatuses.READY);
    });
  });

  describe('lock/unlock — non-blocking (D2: Node-safe only)', () => {
    it('lock() acquires when lock is FREE', () => {
      const orch = new WorkerOrchestrator(1);
      // Fresh orchestrator has FREE lock — CAS succeeds immediately, no Atomics.wait
      expect(() => orch.lock()).not.toThrow();
    });

    it('unlock() releases after lock()', () => {
      const orch = new WorkerOrchestrator(1);
      orch.lock();
      expect(() => orch.unlock()).not.toThrow();
    });

    it('lock() is re-acquirable after unlock()', () => {
      const orch = new WorkerOrchestrator(1);
      orch.lock();
      orch.unlock();
      expect(() => orch.lock()).not.toThrow();
      orch.unlock();
    });
  });

  describe('SAB sharing between two instances', () => {
    it('status changes on orch1 are visible via orch2', () => {
      const orch1 = new WorkerOrchestrator(2);
      const orch2 = new WorkerOrchestrator(orch1.sharedArrayBuffer);
      orch1.setStatus(0, WorkerStatuses.READY);
      expect(orch2.getStatus(0)).toBe(WorkerStatuses.READY);
    });

    it('status changes on orch2 are visible via orch1', () => {
      const orch1 = new WorkerOrchestrator(2);
      const orch2 = new WorkerOrchestrator(orch1.sharedArrayBuffer);
      orch2.setStatus(1, WorkerStatuses.RUNNING);
      expect(orch1.getStatus(1)).toBe(WorkerStatuses.RUNNING);
    });

    it('both instances report the same size', () => {
      const orch1 = new WorkerOrchestrator(2);
      const orch2 = new WorkerOrchestrator(orch1.sharedArrayBuffer);
      expect(orch2.size).toBe(orch1.size);
      expect(orch2.size).toBe(2);
    });

    it('changes to worker 0 do not affect worker 1 across instances', () => {
      const orch1 = new WorkerOrchestrator(2);
      const orch2 = new WorkerOrchestrator(orch1.sharedArrayBuffer);
      orch1.setStatus(0, WorkerStatuses.READY);
      expect(orch2.getStatus(1)).toBe(WorkerStatuses.EMPTY);
    });
  });
});
