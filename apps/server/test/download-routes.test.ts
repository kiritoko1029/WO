import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { registerDownloadRoutes } from '../src/modules/downloads/download-routes.ts';

const openApps: FastifyInstance[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createHarness(): { app: FastifyInstance; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'wo-downloads-'));
  tempRoots.push(root);
  const app = Fastify({ logger: false });
  openApps.push(app);
  registerDownloadRoutes(app, { root });
  return { app, root };
}

describe('download routes', () => {
  test('serves an allowed installer with attachment headers', async () => {
    const { app, root } = createHarness();
    writeFileSync(join(root, 'WO-mac-arm64.dmg'), 'fake-dmg-payload');

    const response = await app.inject({
      method: 'GET',
      url: '/download/WO-mac-arm64.dmg',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/x-apple-diskimage',
    );
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="WO-mac-arm64.dmg"',
    );
    expect(response.body).toBe('fake-dmg-payload');
  });

  test('serves each allowlisted extension with a content type', async () => {
    const { app, root } = createHarness();
    writeFileSync(join(root, 'WO-win-x64-setup.exe'), 'exe');
    writeFileSync(join(root, 'WO-mac.zip'), 'zip');
    writeFileSync(join(root, 'latest.yml'), 'yml');
    writeFileSync(join(root, 'WO-mac.zip.blockmap'), 'blockmap');

    const exe = await app.inject({
      method: 'GET',
      url: '/download/WO-win-x64-setup.exe',
    });
    const zip = await app.inject({
      method: 'GET',
      url: '/download/WO-mac.zip',
    });
    const yml = await app.inject({
      method: 'GET',
      url: '/download/latest.yml',
    });
    const blockmap = await app.inject({
      method: 'GET',
      url: '/download/WO-mac.zip.blockmap',
    });

    expect(exe.headers['content-type']).toBe(
      'application/vnd.microsoft.portable-executable',
    );
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(yml.headers['content-type']).toBe('text/yaml; charset=utf-8');
    expect(blockmap.headers['content-type']).toBe('application/octet-stream');
  });

  test('rejects disallowed extensions with 404', async () => {
    const { app, root } = createHarness();
    writeFileSync(join(root, 'secret.txt'), 'private');
    writeFileSync(join(root, 'payload.sh'), 'evil');

    const txt = await app.inject({
      method: 'GET',
      url: '/download/secret.txt',
    });
    const sh = await app.inject({ method: 'GET', url: '/download/payload.sh' });

    expect(txt.statusCode).toBe(404);
    expect(sh.statusCode).toBe(404);
  });

  test('rejects path traversal attempts with 404', async () => {
    const { app, root } = createHarness();
    writeFileSync(join(root, 'WO.dmg'), 'ok');
    // Place a sensitive file outside the downloads root to prove the route
    // does not let callers reach it.
    const outside = join(root, '..', 'outside.dmg');
    writeFileSync(outside, 'leaked');

    const traversal = await app.inject({
      method: 'GET',
      url: '/download/..%2Foutside.dmg',
    });
    const slash = await app.inject({
      method: 'GET',
      url: '/download/sub/WO.dmg',
    });

    expect(traversal.statusCode).toBe(404);
    expect(slash.statusCode).toBe(404);
  });

  test('returns 404 for a missing file', async () => {
    const { app } = createHarness();

    const response = await app.inject({
      method: 'GET',
      url: '/download/does-not-exist.dmg',
    });

    expect(response.statusCode).toBe(404);
  });

  test('rejects filenames with unusual characters', async () => {
    const { app } = createHarness();

    const space = await app.inject({
      method: 'GET',
      url: '/download/WO%20mac.dmg',
    });
    const unicode = await app.inject({
      method: 'GET',
      url: '/download/%E4%B8%AD.dmg',
    });

    expect(space.statusCode).toBe(404);
    expect(unicode.statusCode).toBe(404);
  });
});
