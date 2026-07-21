import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createApp } from '../src/app.ts';

describe('bundled web client', () => {
  test('serves the SPA without masking API routes', async () => {
    const webRoot = await mkdtemp(join(tmpdir(), 'wo-web-'));
    await mkdir(join(webRoot, 'assets'));
    await writeFile(join(webRoot, 'index.html'), '<main>WO web</main>');
    await writeFile(join(webRoot, 'admin.html'), '<main>WO admin</main>');
    await writeFile(join(webRoot, 'assets', 'app.js'), 'window.wo = true;');
    const app = await createApp({
      authService: {} as never,
      accessTokenService: {} as never,
      readinessCheck: async () => undefined,
      logger: false,
      webRoot,
    });

    try {
      const home = await app.inject({ method: 'GET', url: '/' });
      const joinPage = await app.inject({
        method: 'GET',
        url: '/join/123456',
      });
      const adminPage = await app.inject({ method: 'GET', url: '/admin' });
      const adminNested = await app.inject({
        method: 'GET',
        url: '/admin/users',
      });
      const asset = await app.inject({
        method: 'GET',
        url: '/assets/app.js',
      });
      const missingApi = await app.inject({
        method: 'GET',
        url: '/v1/missing',
      });

      expect(home.statusCode).toBe(200);
      expect(home.body).toBe('<main>WO web</main>');
      expect(home.headers['cache-control']).toBe('public, max-age=0');
      expect(joinPage.body).toBe(home.body);
      expect(adminPage.statusCode).toBe(200);
      expect(adminPage.body).toBe('<main>WO admin</main>');
      expect(adminNested.body).toBe(adminPage.body);
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toBe('window.wo = true;');
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.body).not.toContain('WO web');
      expect(missingApi.body).not.toContain('WO admin');
    } finally {
      await app.close();
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
