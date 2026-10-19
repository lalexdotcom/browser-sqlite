import { describe, expect, it } from 'vitest';
import { withResolvedCapabilities } from '../../harness/browser-provider.ts';

describe('withResolvedCapabilities', () => {
  it('resolves the binaries before the browser opens', async () => {
    // Falsifiable: resolve at construction and a unit-only run installs browsers (spec anti-goal 1).
    const calls: string[] = [];
    const fake = {
      options: { logLevel: 'error' },
      async openBrowser() {
        calls.push('open');
        return this.options;
      },
    };
    const resolve = async () => {
      calls.push('resolve');
      return { chrome: { browser: '/b', driver: '/d' } } as never;
    };
    const p = withResolvedCapabilities(fake, 'chrome', resolve);
    expect(calls).toEqual([]);
    const opened = (await p.openBrowser()) as {
      capabilities: WebdriverIO.Capabilities;
      logLevel: string;
    };
    expect(calls).toEqual(['resolve', 'open']);
    expect(opened.capabilities['goog:chromeOptions']?.binary).toBe('/b');
    expect(opened.logLevel).toBe('error');
  });
});
