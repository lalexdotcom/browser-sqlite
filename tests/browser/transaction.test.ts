import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * Characterization tests for `db.transaction()`.
 *
 * These tests freeze the CURRENT behaviour of the transaction API so that the
 * scheduler/pool refactor (wave 1) can be judged against a known baseline.
 * They are not a specification — where current behaviour is wrong, the test
 * documents it and says so.
 */
describe('transaction() commit semantics', () => {
  it('commits by default and returns the callback value', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_commit (id INTEGER, val TEXT)');

    const returned = await db.transaction(async (tx) => {
      await tx.write("INSERT INTO tx_commit VALUES (1, 'a')");
      await tx.write("INSERT INTO tx_commit VALUES (2, 'b')");
      return 'callback-result';
    });

    expect(returned).toBe('callback-result');

    const rows = await db.read<{ id: number; val: string }>(
      'SELECT * FROM tx_commit ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].val).toBe('b');

    db.close();
  });

  it('rolls back and rethrows when the callback throws', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_throw (id INTEGER)');
    await db.write('INSERT INTO tx_throw VALUES (1)');

    await expect(
      db.transaction(async (tx) => {
        await tx.write('INSERT INTO tx_throw VALUES (2)');
        throw new Error('callback exploded');
      }),
    ).rejects.toThrow('callback exploded');

    const rows = await db.read<{ id: number }>('SELECT id FROM tx_throw');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);

    db.close();
  });

  it('honours a manual rollback() and skips the auto-commit', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_manual_rb (id INTEGER)');

    await db.transaction(async (tx) => {
      await tx.write('INSERT INTO tx_manual_rb VALUES (1)');
      await tx.rollback();
    });

    const rows = await db.read('SELECT id FROM tx_manual_rb');
    expect(rows).toHaveLength(0);

    db.close();
  });

  it('honours a manual commit() and skips the auto-commit', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_manual_c (id INTEGER)');

    await db.transaction(async (tx) => {
      await tx.write('INSERT INTO tx_manual_c VALUES (7)');
      await tx.commit();
    });

    const rows = await db.read<{ id: number }>('SELECT id FROM tx_manual_c');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(7);

    db.close();
  });

  it('rolls back when autoCommit is false', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_no_autocommit (id INTEGER)');

    await db.transaction(
      async (tx) => {
        await tx.write('INSERT INTO tx_no_autocommit VALUES (1)');
      },
      { autoCommit: false },
    );

    const rows = await db.read('SELECT id FROM tx_no_autocommit');
    expect(rows).toHaveLength(0);

    db.close();
  });
});

describe('transaction() readOnly guard', () => {
  it('rejects a write statement inside a readOnly transaction', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_ro (id INTEGER)');
    await db.write('INSERT INTO tx_ro VALUES (1)');

    await expect(
      db.transaction(
        async (tx) => {
          await tx.write('INSERT INTO tx_ro VALUES (2)');
        },
        { readOnly: true },
      ),
      // Message currently carries a typo ("werite") — matched loosely on
      // purpose so the cleanup does not break this test.
    ).rejects.toThrow(/read-only transaction/);

    const rows = await db.read('SELECT id FROM tx_ro');
    expect(rows).toHaveLength(1);

    db.close();
  });

  it('allows reads inside a readOnly transaction', async () => {
    const db = await createTestClient();

    await db.write('CREATE TABLE tx_ro_read (id INTEGER)');
    await db.write('INSERT INTO tx_ro_read VALUES (1), (2)');

    const count = await db.transaction(
      async (tx) => {
        const rows = await tx.read<{ id: number }>(
          'SELECT id FROM tx_ro_read ORDER BY id',
        );
        return rows.length;
      },
      { readOnly: true },
    );

    expect(count).toBe(2);

    db.close();
  });
});

describe('transaction() worker exclusivity (B1)', () => {
  /**
   * KNOWN BUG — B1. `worker.query()`'s `finally` republishes `available` after
   * every statement, while `releaseWorker()` never owns the flag. A worker held
   * by an open transaction is therefore handed to the next requester after its
   * first statement, and an outside read executes INSIDE the transaction.
   *
   * With `poolSize: 1` every read must go to the transaction's own worker, so a
   * correct pool makes the outside read wait for the transaction to finish and
   * observe the rolled-back state (0 rows).
   *
   * `it.fails` asserts the bug is still present. When wave 1 makes
   * `releaseWorker` the single owner of `available`, this test starts passing —
   * which makes `it.fails` fail. That is the signal to drop `.fails`.
   */
  it('does not leak the transaction worker to a concurrent read', async () => {
    const db = await createTestClient({ poolSize: 1 });

    await db.write('CREATE TABLE tx_leak (id INTEGER)');

    let outsideRead: Promise<{ id: number }[]> | undefined;

    await db.transaction(async (tx) => {
      await tx.write('INSERT INTO tx_leak VALUES (1)');

      // Launched from OUTSIDE the transaction, while it is still open.
      outsideRead = db.read<{ id: number }>('SELECT id FROM tx_leak');

      // Give the scheduler a chance to dispatch it.
      await new Promise((resolve) => setTimeout(resolve, 100));

      await tx.rollback();
    });

    const rows = await outsideRead;
    expect(rows).toHaveLength(0);

    db.close();
  });
});
