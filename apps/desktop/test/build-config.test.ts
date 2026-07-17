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
    expect(mainAliases['@wo/server/lite']).toMatch(
      /apps[\\/]server[\\/]src[\\/]lite[\\/]index\.ts$/u,
    );
  });

  it('bundles the LAN runtime and runs a self-containment artifact gate', async () => {
    const configSource = await readFile(
      new URL('../electron.vite.config.ts', import.meta.url),
      'utf8',
    );
    const acceptanceConfigSource = await readFile(
      new URL('../electron.vite.acceptance.config.ts', import.meta.url),
      'utf8',
    );
    const verifierSource = await readFile(
      new URL('../scripts/verify-build.mjs', import.meta.url),
      'utf8',
    );
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, unknown> };

    for (const source of [configSource, acceptanceConfigSource]) {
      expect(source).toContain("'@wo/server/lite'");
      expect(source).toContain("'@fastify/websocket'");
      expect(source).toContain("'fastify'");
      expect(source).toContain("'ws'");
      expect(source).toContain(
        "'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1')",
      );
      expect(source).toContain(
        'externalizeDepsPlugin({ exclude: bundledMainDependencies })',
      );
    }
    expect(verifierSource).toContain('(?:argon2|@wo\\/database)');
    expect(verifierSource).toContain('(?:@fastify\\/websocket|fastify|ws)');
    expect(packageJson.scripts?.postbuild).toBe(
      'node scripts/verify-build.mjs',
    );
  });
});
