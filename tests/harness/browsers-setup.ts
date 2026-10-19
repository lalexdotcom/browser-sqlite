import type { TestProject } from 'vitest/node';
import { type BrowserName, resolveBrowsers } from '../../scripts/browsers.ts';

/**
 * Every browser project declares this globalSetup. Resolving here, in the run's
 * own process, keeps a cold install out of Vitest's session-connect timer,
 * which starts once a test file opens its page; the provider wrapper then finds
 * everything installed. A run that selects no browser project never calls it,
 * so `--project unit` installs nothing.
 */
export default async function setup(
  project: TestProject,
  resolve: typeof resolveBrowsers = resolveBrowsers,
): Promise<void> {
  const name = project.config.browser.name;
  if (name !== 'chrome' && name !== 'firefox') {
    throw new Error(
      `tests/harness/browsers-setup.ts: project "${project.name}" targets "${name}", not chrome or firefox`,
    );
  }
  await resolve([name satisfies BrowserName]);
}
