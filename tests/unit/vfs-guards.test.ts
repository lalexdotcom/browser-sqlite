import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSQLiteClient } from '../../src/client';
import { BUILD_CAPABILITIES, type SQLiteBuild } from '../../src/const/builds';
import { type SQLiteVFS, VFS_CAPABILITIES } from '../../src/const/vfs';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';
import { SQLiteError } from '../../src/types/errors';
import { MAX_DATABASE_NAME } from '../../src/utils';

// Every guard here reads the declaration and throws before any worker, so it
// runs in Node, once per VFS the declaration concerns — a VFS added to
// VFS_CAPABILITIES is covered with no edit here.
const ALL_VFS = Object.keys(VFS_CAPABILITIES) as SQLiteVFS[];
const ALL_BUILDS = Object.keys(BUILD_CAPABILITIES) as SQLiteBuild[];
const fresh = () => `bsq-test-${crypto.randomUUID()}`;
const thrown = (f: () => unknown): SQLiteError => {
  try {
    f();
  } catch (error) {
    if (error instanceof SQLiteError) return error;
    throw error;
  }
  throw new Error('expected a SQLiteError, nothing was thrown');
};

describe('the pool guard', () => {
  const capped = ALL_VFS.filter(
    (vfs) => VFS_CAPABILITIES[vfs].maxPoolSize !== null,
  );

  it('covers at least the VFS capped today', () => {
    expect(capped).toEqual(
      expect.arrayContaining([
        'OPFSCoopSyncVFS',
        'AccessHandlePoolVFS',
        'IDBMirrorVFS',
        'MemoryVFS',
        'MemoryAsyncVFS',
      ]),
    );
  });

  // Falsifiable: drop the pool guard from createSQLiteClient.
  it.each(capped)(
    '%s refuses a pool larger than its cap, and says why',
    (vfs) => {
      const { maxPoolSize, poolLimitReason } = VFS_CAPABILITIES[vfs];
      const error = thrown(() =>
        createSQLiteClient(fresh(), {
          vfs,
          poolSize: (maxPoolSize as number) + 1,
        }),
      );
      expect(error.code).toBe('INVALID_OPTION');
      expect(error.message).toContain(`pool sizes greater than ${maxPoolSize}`);
      expect(error.message).toContain(poolLimitReason as string);
    },
  );
});

describe('the vfs/build combination guard', () => {
  const refused = ALL_VFS.flatMap((vfs) =>
    ALL_BUILDS.filter(
      (b) =>
        !(VFS_CAPABILITIES[vfs].builds as readonly SQLiteBuild[]).includes(b),
    ).map((build) => [vfs, build] as const),
  );

  it('has at least one refused combination to check', () => {
    expect(refused.length).toBeGreaterThan(0);
  });

  // Falsifiable: drop the build guard from createSQLiteClient.
  it.each(refused)(
    'createSQLiteClient refuses %s on %s, naming the builds it supports',
    (vfs, build) => {
      const error = thrown(() => createSQLiteClient(fresh(), { vfs, build }));
      expect(error.code).toBe('INVALID_OPTION');
      expect(error.message).toContain(`cannot run on the '${build}' build`);
      // The whole list, not each name: 'sync' is a substring of 'async'.
      expect(error.message).toContain(
        `Supported: ${VFS_CAPABILITIES[vfs].builds.join(', ')}.`,
      );
    },
  );

  // Falsifiable: drop the build guard from deleteDatabase.
  // The message is matched, not only the code: in Node the persistent VFS
  // also lack their features, and that guard throws INVALID_OPTION too.
  it.each(refused)('deleteDatabase refuses %s on %s', async (vfs, build) => {
    await expect(deleteDatabase(fresh(), { vfs, build })).rejects.toMatchObject(
      {
        code: 'INVALID_OPTION',
        message: expect.stringContaining(`cannot run on the '${build}' build`),
      },
    );
  });
});

describe('the refused pragma guard', () => {
  const refusals = ALL_VFS.flatMap((vfs) =>
    Object.entries(VFS_CAPABILITIES[vfs].refusedPragmas).map(
      ([pragma, reason]) => [vfs, pragma, reason] as const,
    ),
  );

  it('has at least one refused pragma to check', () => {
    expect(refusals.length).toBeGreaterThan(0);
  });

  // Falsifiable: drop assertPragmasAllowed from createSQLiteClient.
  it.each(refusals)(
    '%s refuses PRAGMA %s at construction, with its reason',
    (vfs, pragma, reason) => {
      const error = thrown(() =>
        createSQLiteClient(fresh(), { vfs, pragmas: { [pragma]: '100' } }),
      );
      expect(error.code).toBe('INVALID_PRAGMA');
      expect(error.message).toContain(reason);
    },
  );
});

describe('deleteDatabase on a memory VFS', () => {
  const memory = ALL_VFS.filter(
    (vfs) => VFS_CAPABILITIES[vfs].storage === 'memory',
  );

  // Node has no Worker: resolving at all proves no worker was asked for.
  // Falsifiable: drop the memory early return from deleteDatabase.
  it.each(memory)('%s resolves without a worker', async (vfs) => {
    await expect(deleteDatabase(fresh(), { vfs })).resolves.toBeUndefined();
  });
});

describe('the name length guard', () => {
  // The bound is the same for every VFS; each is checked because the guard
  // runs inside each entry point's own VFS-dependent path. The message is
  // matched, not only the code: in Node every persistent VFS also lacks its
  // features, and that guard throws INVALID_OPTION before any lock too.
  const NAME_TOO_LONG = {
    code: 'INVALID_OPTION',
    message: expect.stringContaining(
      `a database name may have at most ${MAX_DATABASE_NAME}`,
    ),
  };
  // No lock spy: in Node a persistent VFS stops at missingFeature and a memory
  // VFS returns, both before any lock, so a spy could never be called. The
  // message is the proof: the name guard ran before the memory return and
  // the environment guard, and those run before the locks.
  // Falsifiable: move resolveDatabase after missingFeature in deleteDatabase.
  it.each(ALL_VFS)(
    'deleteDatabase refuses a too-long name on %s before its memory and environment guards',
    async (vfs) => {
      await expect(
        deleteDatabase('n'.repeat(60), { vfs }),
      ).rejects.toMatchObject(NAME_TOO_LONG);
    },
  );

  // inspectDatabase's only Web Locks call is locks.entries() -> query().
  // Falsifiable: move resolveDatabase after locks.entries() in inspectDatabase.
  it.each(ALL_VFS.filter((vfs) => VFS_CAPABILITIES[vfs].storage !== 'memory'))(
    'inspectDatabase refuses a too-long name on %s before taking any lock',
    async (vfs) => {
      const query = vi.spyOn(navigator.locks, 'query');
      onTestFinished(() => query.mockRestore());
      await expect(
        inspectDatabase('n'.repeat(60), { vfs }),
      ).rejects.toMatchObject(NAME_TOO_LONG);
      expect(query).not.toHaveBeenCalled();
    },
  );
});
