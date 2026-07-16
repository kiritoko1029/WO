import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('production server image contract', () => {
  test('builds a portable production-only server on the current Node LTS patch', () => {
    const dockerfile = read('apps/server/Dockerfile');

    expect(dockerfile).toContain('node:24.18.0-bookworm-slim');
    expect(dockerfile).toContain('pnpm@10.32.1');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toMatch(
      /pnpm --filter @wo\/server --prod deploy \/opt\/wo-server --legacy/u,
    );
    for (const workspace of ['config', 'database', 'protocol', 'server']) {
      expect(dockerfile).toContain(`pnpm --filter @wo/${workspace} build`);
    }
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
    expect(dockerfile).toContain("-name '*.map'");
    expect(dockerfile).toContain("-name '*.d.ts'");
    expect(dockerfile).not.toMatch(
      /NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate/u,
    );
  });

  test('packages only compiled server workspaces and database migrations', () => {
    const expectedFiles = new Map<string, readonly string[]>([
      ['apps/server/package.json', ['dist']],
      ['packages/config/package.json', ['dist']],
      ['packages/protocol/package.json', ['dist']],
      ['packages/database/package.json', ['dist', 'drizzle']],
    ]);

    for (const [path, files] of expectedFiles) {
      const manifest = JSON.parse(read(path)) as { files?: readonly string[] };
      expect(manifest.files, path).toEqual(files);
    }
  });

  test('keeps unrelated applications, tests, secrets, and build state out of context', () => {
    const dockerIgnore = read('.dockerignore');

    for (const pattern of [
      '**/test/',
      '**/coverage/',
      '**/node_modules/',
      '**/.env',
      '.git/',
      'apps/desktop/',
      'apps/media-lab-desktop/',
      'apps/media-lab-server/',
      'docs/',
      'tests/',
    ]) {
      expect(dockerIgnore, pattern).toContain(pattern);
    }
    expect(dockerIgnore).toContain('!packages/database/drizzle/');
  });
});
