import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Web deployment contract', () => {
  test('builds the Web app into the pinned Caddy image', () => {
    const compose = read('deploy/compose.yaml');
    const dockerfile = read('deploy/caddy/Dockerfile');

    expect(compose).toContain('image: wo-caddy:2.11.4-web.1');
    expect(compose).toContain('dockerfile: deploy/caddy/Dockerfile');
    expect(dockerfile).toContain('pnpm --filter @wo/web build');
    expect(dockerfile).toContain(
      'COPY --from=web-builder /workspace/apps/web/dist /srv',
    );
    expect(dockerfile).toContain('FROM caddy:2.11.4-alpine');
  });

  test.each(['deploy/caddy/Caddyfile', 'deploy/caddy/Caddyfile.integration'])(
    '%s serves the SPA and proxies API plus WebSocket upgrades',
    (path) => {
      const caddyfile = read(path);

      expect(caddyfile).toContain('@api path /v1 /v1/*');
      expect(caddyfile).toContain('reverse_proxy server:3000');
      expect(caddyfile).toContain('root * /srv');
      expect(caddyfile).toContain('try_files {path} /index.html');
      expect(caddyfile).toContain('file_server');
    },
  );
});
