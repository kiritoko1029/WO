import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const REQUIRED_BUILD_ORDER = [
  '@wo/config',
  '@wo/database',
  '@wo/protocol',
] as const;

type ServerPackageJson = Readonly<{
  scripts?: Readonly<Record<string, string>>;
}>;

async function readServerPackageJson(): Promise<ServerPackageJson> {
  const contents = await readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  );

  return JSON.parse(contents) as ServerPackageJson;
}

describe('server development scripts', () => {
  test('builds runtime workspace packages in order before starting watch mode', async () => {
    const packageJson = await readServerPackageJson();
    const predev = packageJson.scripts?.predev;

    expect(predev).toBeTypeOf('string');
    if (typeof predev !== 'string') {
      throw new TypeError('The server package must define a predev script');
    }

    expect(predev.split(/\s*&&\s*/u)).toEqual(
      REQUIRED_BUILD_ORDER.map(
        (packageName) => `pnpm --filter ${packageName} build`,
      ),
    );
    expect(packageJson.scripts?.dev).toBe(
      'node --watch --env-file-if-exists=../../deploy/.env.local src/index.ts',
    );
  });
});
