import { webdriverio } from '@vitest/browser-webdriverio';
import type { BrowserProvider } from 'vitest/node';
import {
  type BrowserName,
  browserCapabilities,
  resolveBrowsers,
} from '../../scripts/browsers.ts';

/**
 * Makes `provider` name the installed binaries when its browser opens, not
 * when it is built: a unit-only run constructs no provider's browser, so it
 * installs nothing. `@vitest/browser-webdriverio` reads `options.capabilities`
 * only in `openBrowser()`.
 */
export function withResolvedCapabilities<
  P extends {
    options?: object;
    openBrowser(): Promise<unknown>;
  },
>(provider: P, browser: BrowserName, resolve = resolveBrowsers): P {
  // A provider that changed shape would otherwise run unwrapped and let WebdriverIO download.
  if (!('options' in provider) || typeof provider.openBrowser !== 'function') {
    throw new Error(
      '@vitest/browser-webdriverio: the provider no longer has an `options` property and an `openBrowser()` method; tests/harness/browser-provider.ts must follow',
    );
  }
  const open = provider.openBrowser.bind(provider);
  provider.openBrowser = async () => {
    const resolved = await resolve([browser]);
    provider.options = {
      ...provider.options,
      capabilities: browserCapabilities(browser, resolved[browser]),
    } as NonNullable<P['options']>;
    return open();
  };
  return provider;
}

/** `webdriverio(options)` whose every provider resolves its binaries on open. */
export function resolvingWebdriverio(
  browser: BrowserName,
  options: Omit<Parameters<typeof webdriverio>[0], 'capabilities'>,
): ReturnType<typeof webdriverio> {
  const base = webdriverio(options);
  return {
    ...base,
    // `options` and `openBrowser` are the WebdriverIO provider's own, which
    // the generic BrowserProvider type does not name.
    providerFactory: (project) =>
      withResolvedCapabilities(
        base.providerFactory(project) as BrowserProvider & {
          options?: object;
          openBrowser(): Promise<unknown>;
        },
        browser,
      ),
  };
}
