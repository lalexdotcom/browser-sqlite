import type { TestProject } from 'vitest/node';
import { isBrowserName, resolveBrowsers } from '../../scripts/browsers.ts';

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
  if (!isBrowserName(name)) {
    throw new Error(
      `tests/harness/browsers-setup.ts: project "${project.name}" targets "${name}", not chrome, firefox or safari`,
    );
  }
  // Off macOS, Safari's projects stop here with the macOS-only error.
  await resolve([name]);
}
