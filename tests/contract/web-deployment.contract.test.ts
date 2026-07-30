import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Web deployment contract', () => {
  test('builds the Web app into the release-versioned Caddy image', () => {
    const compose = read('deploy/compose.yaml');
    const dockerfile = read('deploy/caddy/Dockerfile');

    expect(compose).toContain("image: 'wo-caddy:${BUILD_VERSION:-unresolved}'");
    expect(compose).toContain('dockerfile: deploy/caddy/Dockerfile');
    expect(dockerfile).toContain('pnpm --filter @wo/web build');
    expect(dockerfile).toContain(
      'COPY --from=web-builder /workspace/apps/web/dist /srv',
    );
    expect(dockerfile).toContain(
      'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
    );
    expect(dockerfile).toContain(
      'caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
    );
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

  test('keeps the external proxy on one sanitized loopback hop', () => {
    const deployment = read('docs/deployment.md');
    const serverEntry = read('apps/server/src/index.ts');

    expect(
      deployment.match(/proxy_set_header X-Forwarded-For\s+\$remote_addr;/gu),
    ).toHaveLength(2);
    expect(deployment).not.toMatch(
      /proxy_set_header X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/gu,
    );
    expect(deployment).toContain('proxy_pass http://127.0.0.1:18080;');
    expect(deployment).toContain('`18080` 必须继续绑定');
    expect(serverEntry).toContain(
      "trustProxy: config.nodeEnv === 'production' ? 1 : false",
    );
  });

  test('supports an explicit E2E origin without widening desktop certificate trust', () => {
    const webPlaywright = read('apps/web/playwright.config.ts');
    const desktopFixture = read('apps/desktop/e2e/fixtures.ts');
    const acceptanceMain = read('apps/desktop/src/main/index.acceptance.ts');
    const acceptanceCertificate = read(
      'apps/desktop/src/main/acceptance-certificate.ts',
    );

    expect(webPlaywright).toContain('process.env.WO_E2E_BASE_URL');
    expect(desktopFixture).toContain('process.env.WO_E2E_BASE_URL');
    for (const source of [
      desktopFixture,
      acceptanceMain,
      acceptanceCertificate,
    ]) {
      expect(source).toContain("hostname !== 'rtc.localhost'");
    }
    expect(acceptanceCertificate).toContain(
      "request.error !== 'net::ERR_CERT_AUTHORITY_INVALID'",
    );
    expect(acceptanceCertificate).toContain(
      'timingSafeEqual(spkiSha256(root), expectedPin)',
    );
  });
});
