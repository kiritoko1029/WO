import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import electronViteConfig from '../electron.vite.config.js';

function aliasRecord(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Expected alias record');
  }
  return input as Record<string, string>;
}

describe('desktop clean-build configuration', () => {
  it('aliases protocol source into main, preload, and renderer bundles', () => {
    const mainAliases = aliasRecord(electronViteConfig.main?.resolve?.alias);
    const preloadAliases = aliasRecord(
      electronViteConfig.preload?.resolve?.alias,
    );
    const rendererAliases = aliasRecord(
      electronViteConfig.renderer?.resolve?.alias,
    );

    for (const aliases of [mainAliases, preloadAliases, rendererAliases]) {
      expect(aliases['@wo/protocol']).toMatch(
        /packages[\\/]protocol[\\/]src[\\/]index\.ts$/u,
      );
    }
  });

  it('bundles protocol and zod in main and runs a postbuild artifact gate', async () => {
    const configSource = await readFile(
      new URL('../electron.vite.config.ts', import.meta.url),
      'utf8',
    );
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, unknown> };

    expect(configSource).toMatch(
      /externalizeDepsPlugin\(\{\s*exclude:\s*\['@wo\/protocol',\s*'zod'\]/u,
    );
    expect(packageJson.scripts?.postbuild).toBe(
      'node scripts/verify-build.mjs',
    );
  });
});
