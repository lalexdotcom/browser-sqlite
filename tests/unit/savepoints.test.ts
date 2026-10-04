import { describe, expect, it } from '@rstest/core';
import { createSavepointStack } from '../../src/savepoints';

describe('savepoint stack — names (spec 2026-10-04, D3)', () => {
  it('generates __bsq_sp_<n>, counting from 1 per stack', () => {
    const stack = createSavepointStack();
    expect(stack.open().name).toBe('__bsq_sp_1');
    expect(stack.open().name).toBe('__bsq_sp_2');
    expect(createSavepointStack().open().name).toBe('__bsq_sp_1');
  });

  for (const [label, name] of [
    ['empty', ''],
    ['not a string', 42],
    ['NUL', 'a\0b'],
    ['reserved prefix', '__bsq_mine'],
    ['reserved prefix, other case', '__BSQ_SP_1'],
  ] as const) {
    it(`refuses a name that is ${label} with INVALID_IDENTIFIER`, () => {
      expect(() => createSavepointStack().open(name)).toThrow(
        expect.objectContaining({ code: 'INVALID_IDENTIFIER' }),
      );
    });
  }

  // Falsifiable: compare names case-sensitively in open().
  it('refuses a name already open, ignoring case as SQLite does', () => {
    const stack = createSavepointStack();
    stack.open('Step');
    expect(() => stack.open('STEP')).toThrow(
      expect.objectContaining({ code: 'INVALID_IDENTIFIER' }),
    );
  });

  it('accepts a name again once it has closed', () => {
    const stack = createSavepointStack();
    stack.release(stack.open('step'));
    expect(stack.open('step').name).toBe('step');
  });
});

describe('savepoint stack — what each operation sends (spec 2026-10-04, § 3)', () => {
  it('releases an open savepoint, then does nothing on a second release', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    expect(stack.release(sp)).toBe('send');
    expect(sp.state).toBe('released');
    expect(stack.release(sp)).toBe('noop');
  });

  it('rolls back and closes by default, then does nothing on a second rollback', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    expect(stack.rollback(sp, true)).toBe('send');
    expect(sp.state).toBe('rolled-back');
    expect(stack.rollback(sp, true)).toBe('noop');
  });

  // Falsifiable: close the entry itself whatever `release` says.
  it('keeps the savepoint open after rollback without release', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    expect(stack.rollback(sp, false)).toBe('send');
    expect(sp.state).toBe('open');
    expect(stack.rollback(sp, false)).toBe('send');
    expect(stack.release(sp)).toBe('send');
  });

  it('refuses to roll back a released savepoint with SAVEPOINT_CLOSED', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    stack.release(sp);
    expect(() => stack.rollback(sp, true)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'release', savepoint: 'a' },
      }),
    );
  });

  it('refuses to release a rolled-back savepoint with SAVEPOINT_CLOSED', () => {
    const stack = createSavepointStack();
    const sp = stack.open('a');
    stack.rollback(sp, true);
    expect(() => stack.release(sp)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'rollback', savepoint: 'a' },
      }),
    );
  });
});

describe('savepoint stack — a parent closes its children (spec 2026-10-04, E5-E7)', () => {
  // Falsifiable: in release(), mark only the entry itself.
  it("releases the children with the parent's release", () => {
    const stack = createSavepointStack();
    const parent = stack.open('p');
    const child = stack.open('c');
    stack.release(parent);
    expect(child.state).toBe('released');
    expect(stack.release(child)).toBe('noop');
    expect(() => stack.rollback(child, true)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'release', savepoint: 'p' },
      }),
    );
  });

  // Falsifiable: in rollback(), leave the entries above the target open.
  it("rolls the children back with the parent's rollback, even when the parent stays open", () => {
    const stack = createSavepointStack();
    const parent = stack.open('p');
    const child = stack.open('c');
    stack.rollback(parent, false);
    expect(parent.state).toBe('open');
    expect(child.state).toBe('rolled-back');
    expect(stack.rollback(child, true)).toBe('noop');
    expect(() => stack.release(child)).toThrow(
      expect.objectContaining({
        code: 'SAVEPOINT_CLOSED',
        cause: { by: 'rollback', savepoint: 'p' },
      }),
    );
  });

  it('frees a closed child name for reuse under the open parent', () => {
    const stack = createSavepointStack();
    stack.open('p');
    stack.release(stack.open('c'));
    expect(stack.open('c').state).toBe('open');
  });
});
