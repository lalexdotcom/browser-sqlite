/**
 * The browsers' names and lists, apart from `browsers.ts` (which re-exports
 * them): the planner's need vocabulary (`tests/harness/planner/need.ts`) runs
 * in the browser too, and must not pull the installer's Node dependencies in.
 * No import here.
 */

export type BrowserName = 'chrome' | 'firefox' | 'safari';

/** The browsers `browsers.ts` downloads and pins; Safari comes with macOS. */
export type DownloadedBrowser = Exclude<BrowserName, 'safari'>;

/** Every browser a harness can drive. */
export const ALL_BROWSERS: readonly BrowserName[] = [
  'chrome',
  'firefox',
  'safari',
];

/** What runs unless a browser is named: Safari is opt-in everywhere, macOS included. */
export const DEFAULT_BROWSERS: readonly BrowserName[] = ['chrome', 'firefox'];

export const isBrowserName = (name: string): name is BrowserName =>
  (ALL_BROWSERS as readonly string[]).includes(name);
