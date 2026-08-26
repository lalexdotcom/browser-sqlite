import {
  BUILD_REQUIREMENTS,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from './types';

/**
 * Synchronous platform probes, keyed by FEATURE rather than by VFS or by build.
 * That is what lets a VFS requirement and a build requirement travel one path.
 *
 * `WebAssembly.Suspending` is cast rather than declared globally: it is not in
 * lib.dom, and a global augmentation would leak the assertion into every file.
 */
const PROBES: Partial<Record<PlatformFeature, () => boolean>> = {
  opfs: () =>
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined',
  jspi: () =>
    typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function',
  'writable-stream': () =>
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function',
};

/**
 * Features with no synchronous probe. Declared, never merely omitted.
 *
 * WebIDL ignores an unknown dictionary member, so asking whether
 * `readwrite-unsafe` is supported answers yes and is wrong. Detecting it means
 * opening two access handles on one file inside a dedicated worker — which the
 * benchmark page does, asynchronously. A feature in neither table is a mistake,
 * and `tests/unit/capabilities.test.ts` says so.
 */
const UNPROBEABLE = new Set<PlatformFeature>(['readwrite-unsafe']);

/** Human-readable names for the error messages. */
const FEATURE_LABEL: Record<PlatformFeature, string> = {
  opfs: 'OPFS',
  jspi: 'JSPI',
  'writable-stream': 'FileSystemWritableFileStream',
  'readwrite-unsafe': 'readwrite-unsafe access handles',
};

/**
 * Every feature this module can decide: probed, or explicitly exempt. A
 * feature declared in a capability table and absent here is a mistake, and
 * tests/unit/capabilities.test.ts is what says so.
 */
export const KNOWN_FEATURES: ReadonlySet<PlatformFeature> = new Set([
  ...(Object.keys(PROBES) as PlatformFeature[]),
  ...UNPROBEABLE,
]);

/** What this engine can do, probed once by the caller. */
export const detectFeatures = (): ReadonlySet<PlatformFeature> => {
  const found = new Set<PlatformFeature>();
  for (const [feature, probe] of Object.entries(PROBES)) {
    if (probe()) found.add(feature as PlatformFeature);
  }
  return found;
};

/**
 * The first feature this pair needs and this engine lacks, or null.
 *
 * Pure, and takes `available` rather than probing, because the branches worth
 * testing are the negative ones and they are unreachable in a real browser:
 * JSPI cannot be taken away from Chromium.
 */
export const missingFeature = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  available: ReadonlySet<PlatformFeature>,
): PlatformFeature | null => {
  const required: readonly PlatformFeature[] = [
    ...VFS_CAPABILITIES[vfs].requires,
    ...BUILD_REQUIREMENTS[build],
  ];
  for (const feature of required) {
    if (UNPROBEABLE.has(feature)) continue;
    if (!available.has(feature)) return feature;
  }
  return null;
};

/**
 * The message for a missing feature, derived from the capability tables so it
 * cannot drift from them. Names an alternative build when the build is at
 * fault, and VFS that do not need the feature when the VFS is.
 */
export const describeMissing = (
  vfs: SQLiteVFS,
  build: SQLiteBuild,
  feature: PlatformFeature,
): string => {
  const label = FEATURE_LABEL[feature];

  if (
    (BUILD_REQUIREMENTS[build] as readonly PlatformFeature[]).includes(feature)
  ) {
    const others = VFS_CAPABILITIES[vfs].builds.filter((b) => b !== build);
    const suffix = others.length
      ? ` ${vfs} also runs on: ${others.join(', ')}.`
      : '';
    return `This browser does not support ${label}, which the '${build}' build requires.${suffix}`;
  }

  const alternatives = (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[]).filter(
    (name) =>
      !(VFS_CAPABILITIES[name].requires as readonly PlatformFeature[]).includes(
        feature,
      ),
  );
  const suffix = alternatives.length
    ? ` Without it, these store elsewhere: ${alternatives.join(', ')}.`
    : '';
  return `This browser does not support ${label}, which ${vfs} requires.${suffix}`;
};
