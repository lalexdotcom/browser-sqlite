import { describe, expect, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import setup from '../../harness/browsers-setup.ts';

const project = (name: string) =>
  ({ name: `p ${name}`, config: { browser: { name } } }) as TestProject;

describe('browsers-setup globalSetup', () => {
  it("resolves exactly the project's browser", async () => {
    // Falsifiable: resolve every browser and a Chrome project waits on Firefox's install too.
    const asked: string[][] = [];
    const resolve = (async (names: string[]) => {
      asked.push(names);
      return {};
    }) as never;
    await setup(project('firefox'), resolve);
    await setup(project('chrome'), resolve);
    expect(asked).toEqual([['firefox'], ['chrome']]);
  });

  it('resolves Safari like the others', async () => {
    // Falsifiable: skip Safari here and off macOS its projects reach a test before the macOS-only error.
    const asked: string[][] = [];
    const resolve = (async (names: string[]) => {
      asked.push(names);
      return {};
    }) as never;
    await setup(project('safari'), resolve);
    expect(asked).toEqual([['safari']]);
  });

  it('refuses a browser it cannot install', async () => {
    // Falsifiable: pass the name through and an edge project asks the installer for nothing it knows.
    const resolve = (async () => {
      throw new Error('must not resolve');
    }) as never;
    await expect(setup(project('edge'), resolve)).rejects.toThrow(
      'not chrome, firefox or safari',
    );
  });
});
