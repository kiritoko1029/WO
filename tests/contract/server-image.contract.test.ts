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
    const entrypoint = read('deploy/server/entrypoint.sh');

    expect(
      dockerfile.match(/FROM node:24\.18\.0-bookworm-slim@sha256:/gu),
    ).toHaveLength(2);
    expect(dockerfile).toContain(
      'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
    );
    expect(dockerfile).toContain('pnpm@10.32.1');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toMatch(
      /pnpm --filter @wo\/server --prod deploy \/opt\/wo-server --legacy/u,
    );
    for (const workspace of ['config', 'database', 'protocol', 'server']) {
      expect(dockerfile).toContain(`pnpm --filter @wo/${workspace} build`);
    }
    expect(dockerfile).toContain('USER root');
    expect(dockerfile).toContain(
      'ENTRYPOINT ["/usr/local/bin/wo-server-entrypoint"]',
    );
    for (const label of [
      'org.opencontainers.image.created',
      'org.opencontainers.image.revision',
      'org.opencontainers.image.source',
      'org.opencontainers.image.version',
    ]) {
      expect(dockerfile).toContain(label);
    }
    expect(entrypoint).toContain('exec /usr/bin/setpriv');
    expect(entrypoint).toContain('--reuid=1000');
    expect(entrypoint).toContain('--regid=1000');
    expect(entrypoint).toContain('--no-new-privs');
    expect(entrypoint).toContain('--bounding-set=-all');
    expect(entrypoint).toContain('/usr/local/bin/node /app/dist/index.js');
    expect(dockerfile).toContain("-name '*.map'");
    expect(dockerfile).toContain("-name '*.d.ts'");
    expect(dockerfile).toContain(
      'rm -f /opt/wo-server/node_modules/.modules.yaml',
    );
    expect(dockerfile).toContain('rm -rf /var/log/apt/*');
    expect(dockerfile).toContain('/var/cache/ldconfig/aux-cache');
    expect(dockerfile).toContain('/var/log/alternatives.log');
    expect(dockerfile).toContain('/var/log/dpkg.log');
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
