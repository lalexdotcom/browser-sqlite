import { onTestFinished } from '@rstest/core';

/** The slice of the Web Locks API these helpers use. */
type LockManager = {
  request: (
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: () => Promise<unknown>,
  ) => Promise<unknown>;
  query: () => Promise<{ held?: { name?: string }[] }>;
};

/**
 * A second realm on this origin: a hidden same-origin `about:blank` iframe.
 *
 * This is the ONLY thing in the suite that can stand in for another tab where
 * the epoch is concerned. Web Locks and OPFS are scoped to the origin and are
 * therefore already shared by two clients in one page — but `epochs.ts` keeps
 * its Map on `globalThis`, which an iframe does not share. Verified on
 * Chromium 151 and Firefox 153 before this was written; `Symbol.for()` IS
 * shared across realms, so the separation comes from `globalThis` alone.
 */
export const makeRealm = (): Promise<Window> =>
  new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = 'about:blank';
    iframe.addEventListener('load', () => {
      const win = iframe.contentWindow;
      if (win) resolve(win as Window);
      else reject(new Error('iframe produced no contentWindow'));
    });
    iframe.addEventListener('error', () =>
      reject(new Error('iframe failed to load')),
    );
    onTestFinished(() => iframe.remove());
    document.body.appendChild(iframe);
  });

/** Holds `name` in `realm`, resolving with its releaser. */
export const holdIn = (
  realm: Window,
  name: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<() => void> =>
  new Promise<() => void>((resolveReleaser, reject) => {
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    (realm.navigator.locks as unknown as LockManager)
      .request(name, { mode }, () => {
        resolveReleaser(release);
        return held;
      })
      .catch(reject);
  });

/** Every lock name the origin holds, as seen from `realm`. */
export const heldNamesIn = async (realm: Window): Promise<string[]> => {
  const snapshot = await (
    realm.navigator.locks as unknown as LockManager
  ).query();
  return (snapshot.held ?? []).map((lock) => lock.name ?? '');
};
