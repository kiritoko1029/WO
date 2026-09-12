import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  configureSetup,
  managedActionCommands,
  managedComposeArguments,
  parseSetupArguments,
} from '../../deploy/scripts/setup.mjs';

const roots: string[] = [];
const provenance = {
  BUILD_CREATED: '2026-09-12T00:00:00Z',
  BUILD_REVISION: 'a'.repeat(40),
  BUILD_VERSION: `2026.09.12-${'a'.repeat(12)}`,
  SOURCE_DATE_EPOCH: '1789171200',
};
const options = {
  action: 'configure',
  'non-interactive': true,
  project: 'wo-panel',
  domain: 'wo.example.com',
  email: 'operator@example.com',
  'admin-email': 'admin@example.com',
  'public-ip': '8.8.8.8',
};
const certDir = '/opt/1panel/www/sites/wo.example.com/ssl';
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'wo-panel-config-'));
  roots.push(root);
  return { root, platform: 'linux', provenanceProvider: () => provenance };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('1Panel guided setup', () => {
  test('generates a loopback upstream with canonical external HTTPS and a single-hop websocket snippet', async () => {
    const deps = await workspace();
    const setup = await configureSetup(
      { ...options, '1panel': true, 'cert-dir': certDir },
      deps,
    );
    expect(setup.environment).toMatchObject({
      WO_INGRESS: '1panel',
      WO_TLS_MODE: 'external',
      WO_HTTP_PORT: '18080',
      WO_HTTPS_PORT: '443',
      WO_PUBLIC_ORIGIN: 'https://wo.example.com',
      WO_EXTERNAL_CERT_DIR: certDir,
    });
    expect(
      managedComposeArguments(setup, 'config', '--quiet').join(' '),
    ).toContain('compose.1panel.yaml');
    const snippet = await readFile(
      join(setup.stateDirectory, 'openresty-location.conf'),
      'utf8',
    );
    expect(snippet).toContain('proxy_pass http://127.0.0.1:18080;');
    expect(snippet).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(snippet).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(snippet).not.toContain('$proxy_add_x_forwarded_for');
    expect(snippet).not.toContain('ssl_certificate');
    const commands = managedActionCommands(setup, 'up');
    expect(commands).toHaveLength(2);
    expect(commands[0].slice(-4)).toEqual(['rm', '--stop', '--force', 'caddy']);
    expect(commands[0]).not.toContain('--volumes');
    expect(managedActionCommands(setup, 'sync-cert')[0].at(-1)).toBe(
      '--sync-now',
    );
    expect(() => managedActionCommands(setup, 'renew')).toThrow(
      'Renew the certificate in 1Panel',
    );
    expect(
      parseSetupArguments(['up', '--1panel', '--cert-dir', certDir])['1panel'],
    ).toBe(true);
  });

  test('explicitly converts a failed installation and recovers an interrupted conversion without changing credentials', async () => {
    const deps = await workspace();
    const original = await configureSetup(options, deps);
    const oldEnv = await readFile(original.envFile, 'utf8');
    const oldPorts = await readFile(original.overlayFile, 'utf8');
    const files = [
      'secrets/bootstrap_admin_password',
      'secrets/jwt_access_secret',
      'secrets/postgres_password',
      'secrets/turn_shared_secret',
      'first-login.txt',
    ];
    const before = await Promise.all(
      files.map((name) =>
        readFile(join(original.stateDirectory, name), 'utf8'),
      ),
    );
    const next = {
      ...options,
      action: 'up',
      '1panel': true,
      'refresh-build': true,
      'cert-dir': certDir,
    };
    await expect(
      configureSetup({ ...next, 'refresh-build': false }, deps),
    ).rejects.toThrow('Switching to 1Panel requires');
    const converted = await configureSetup(next, deps);
    expect(converted.environment.WO_DEPLOYMENT_ID).toBe(
      original.environment.WO_DEPLOYMENT_ID,
    );
    expect(converted.environment.WO_PUBLIC_ORIGIN).toBe(
      original.environment.WO_PUBLIC_ORIGIN,
    );
    expect(converted.environment.WO_HTTP_PORT).toBe('18080');
    expect(
      await Promise.all(
        files.map((name) =>
          readFile(join(original.stateDirectory, name), 'utf8'),
        ),
      ),
    ).toEqual(before);
    await writeFile(original.envFile, oldEnv);
    await writeFile(original.overlayFile, oldPorts);
    await configureSetup(next, deps);
    const resumed = await configureSetup(
      { action: 'status', project: options.project },
      deps,
    );
    expect(resumed.environment.WO_TLS_MODE).toBe('external');
    expect(resumed.environment.WO_EXTERNAL_CERT_DIR).toBe(certDir);
    await expect(
      configureSetup({ ...next, domain: 'changed.example.com' }, deps),
    ).rejects.toThrow('Configuration differs');
    await writeFile(join(original.stateDirectory, 'started.json'), '{}');
    await expect(configureSetup(next, deps)).rejects.toThrow(
      'unfinished production',
    );
  });

  test.each([
    '/var/run',
    '/',
    'relative/ssl',
    '/opt/sites/../ssl',
    '/opt/sites/site/ssl\nOTHER=x',
  ])('rejects unsafe or broad certificate mounts: %s', async (directory) => {
    await expect(
      configureSetup(
        { ...options, '1panel': true, 'cert-dir': directory },
        await workspace(),
      ),
    ).rejects.toThrow();
  });

  test('rejects path traversal filenames and mixing the local issuer with 1Panel', async () => {
    await expect(
      configureSetup(
        {
          ...options,
          '1panel': true,
          'cert-dir': certDir,
          'key-file': '../key.pem',
        },
        await workspace(),
      ),
    ).rejects.toThrow('simple filenames');
    await expect(
      configureSetup(
        { ...options, local: true, '1panel': true, 'cert-dir': certDir },
        await workspace(),
      ),
    ).rejects.toThrow('cannot be combined');
  });
});
