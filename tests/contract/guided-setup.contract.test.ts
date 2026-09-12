import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  configureSetup,
  managedActionCommands,
  managedComposeArguments,
  managedProcessEnvironment,
  parseSetupArguments,
  setupStateDirectory,
  verifyManagedDns,
  verifyManagedResourceOwnership,
} from '../../deploy/scripts/setup.mjs';
import {
  parseDotEnv,
  validateGeneratedSecret,
} from '../../deploy/scripts/lib.mjs';

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'wo-guided-contract-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('guided deployment setup', () => {
  it('creates independent secret files and literal local origins without leaking passwords into settings', async () => {
    const root = await workspace();
    const result = await configureSetup(
      {
        action: 'configure',
        local: true,
        project: 'wo-test',
        'https-port': '28443',
      },
      { root },
    );
    const environment = parseDotEnv(await readFile(result.envFile, 'utf8'));
    expect(environment.WO_PUBLIC_ORIGIN).toBe('https://wo.localhost:28443');
    expect(environment.TURN_HOST).toBe(environment.APP_DOMAIN);
    expect(environment.DEPLOY_SECRET_DIR).toBe('./.managed/wo-test/secrets');
    expect(environment.BUILD_VERSION).toBe('integration');
    const secretValues = await Promise.all(
      [
        'jwt_access_secret',
        'postgres_password',
        'turn_shared_secret',
        'bootstrap_admin_password',
      ].map(async (name) =>
        (
          await readFile(join(result.stateDirectory, 'secrets', name), 'utf8')
        ).trim(),
      ),
    );
    expect(new Set(secretValues).size).toBe(4);
    const serialized = await readFile(
      join(result.stateDirectory, 'settings.json'),
      'utf8',
    );
    for (const secret of secretValues) {
      expect(validateGeneratedSecret(secret)).toBeNull();
      expect(serialized).not.toContain(secret);
    }
    expect(await readFile(result.receiptFile, 'utf8')).toContain(
      secretValues[3],
    );
    const ports = await readFile(result.overlayFile, 'utf8');
    expect(ports).toContain("published: '28443'");
    expect(ports).toContain('host_ip: 127.0.0.1');
    expect(ports).not.toContain('0.0.0.0');
    if (process.platform !== 'win32') {
      expect((await stat(result.stateDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(result.receiptFile)).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves generated state and uses start without build after successful first startup', async () => {
    const root = await workspace();
    const options = { action: 'configure', local: true, project: 'wo-repeat' };
    const first = await configureSetup(options, { root });
    const before = await readFile(first.receiptFile, 'utf8');
    await writeFile(join(first.stateDirectory, 'started.json'), '{}');
    const second = await configureSetup({ ...options, action: 'up' }, { root });
    expect(await readFile(second.receiptFile, 'utf8')).toBe(before);
    expect(managedActionCommands(second, 'up')[0].slice(-4)).toEqual([
      'start',
      '--wait',
      '--wait-timeout',
      '600',
    ]);
    expect(managedActionCommands(first, 'up')[0]).toContain('--build');
    expect(managedActionCommands(second, 'stop')[0].at(-1)).toBe('stop');
    expect(managedActionCommands(second, 'renew')[0].slice(-4)).toEqual([
      '-T',
      'certificates',
      '/opt/wo/certificates.sh',
      '--renew-now',
    ]);
    expect(managedComposeArguments(second, 'config', '--quiet')).toContain(
      second.envFile,
    );
  });

  it('rejects identity/configuration changes and does not overwrite generated files', async () => {
    const root = await workspace();
    const options = { action: 'configure', local: true, project: 'wo-fixed' };
    const first = await configureSetup(options, { root });
    const original = await readFile(first.envFile, 'utf8');
    await expect(
      configureSetup({ ...options, domain: 'other.localhost' }, { root }),
    ).rejects.toThrow('Configuration differs');
    expect(await readFile(first.envFile, 'utf8')).toBe(original);
    await writeFile(
      first.envFile,
      original.replace('wo.localhost', 'edited.localhost'),
    );
    await expect(configureSetup(options, { root })).rejects.toThrow(
      'Generated environment differs',
    );
  });

  it('fails if an established secret disappears instead of silently resetting it', async () => {
    const root = await workspace();
    const options = { action: 'configure', local: true, project: 'wo-secret' };
    const first = await configureSetup(options, { root });
    await rm(join(first.stateDirectory, 'secrets', 'postgres_password'));
    await expect(configureSetup(options, { root })).rejects.toThrow(
      'secret is missing',
    );
  });

  it('allows interrupted settings generation to resume while retaining the original password', async () => {
    const root = await workspace();
    const options = { action: 'configure', local: true, project: 'wo-resume' };
    const first = await configureSetup(options, { root });
    const password = await readFile(
      join(first.stateDirectory, 'secrets', 'bootstrap_admin_password'),
      'utf8',
    );
    await rm(first.envFile);
    await rm(first.overlayFile);
    const resumed = await configureSetup(options, { root });
    expect(
      await readFile(
        join(resumed.stateDirectory, 'secrets', 'bootstrap_admin_password'),
        'utf8',
      ),
    ).toBe(password);
    expect(
      parseDotEnv(await readFile(resumed.envFile, 'utf8'))
        .BOOTSTRAP_ADMIN_EMAIL,
    ).toBe('admin@wo.localhost');
  });

  it('accepts a password file once and never replaces an existing administrator password', async () => {
    const root = await workspace();
    const passwordFile = join(root, 'initial.txt');
    await writeFile(passwordFile, 'Strong! Initial 2026\n');
    const options = {
      action: 'configure',
      local: true,
      project: 'wo-password',
      'password-file': 'initial.txt',
    };
    const first = await configureSetup(options, { root });
    expect(
      await readFile(
        join(first.stateDirectory, 'secrets/bootstrap_admin_password'),
        'utf8',
      ),
    ).toBe('Strong! Initial 2026\n');
    await writeFile(passwordFile, 'Changed! Initial 2026\n');
    await expect(configureSetup(options, { root })).rejects.toThrow(
      'already configured',
    );
  });

  it.each(['password-file', 'interactive'])(
    'preserves leading and trailing password spaces in the first-login receipt for %s input',
    async (source) => {
      const root = await workspace();
      const password = '  Strong! Initial 2026  ';
      if (source === 'password-file') {
        await writeFile(join(root, 'initial.txt'), `${password}\r\n`);
      }
      const result = await configureSetup(
        {
          action: 'configure',
          local: true,
          project: 'wo-password-spaces',
          ...(source === 'password-file'
            ? { 'password-file': 'initial.txt' }
            : { initialPassword: password }),
        },
        { root },
      );
      expect(
        await readFile(
          join(result.stateDirectory, 'secrets/bootstrap_admin_password'),
          'utf8',
        ),
      ).toBe(`${password}\n`);
      const receipt = await readFile(result.receiptFile, 'utf8');
      expect(
        receipt.split('\n').find((line) => line.startsWith('Password: ')),
      ).toBe(`Password: ${password}`);
    },
  );

  it.each([
    { domain: 'wo.localhost\nEVIL=yes' },
    { domain: '$(touch x).localhost' },
    { email: 'bad$USER@wo.localhost' },
    { 'admin-email': 'a@wo.localhost\rBCC:other' },
    { 'http-port': '18443' },
    { 'https-port': '55005' },
    { 'relay-max': '55500' },
    { 'turn-host': 'other.localhost' },
  ])('rejects invalid input before writing settings: %j', async (overrides) => {
    const root = await workspace();
    await expect(
      configureSetup(
        { action: 'configure', local: true, ...overrides },
        { root },
      ),
    ).rejects.toThrow();
  });

  it('restricts state paths and rejects unknown, duplicate or password command-line arguments', () => {
    expect(() => setupStateDirectory({ project: 'Bad Name' })).toThrow();
    expect(() =>
      setupStateDirectory({ 'state-dir': '../elsewhere' }),
    ).toThrow();
    expect(() =>
      setupStateDirectory({ 'state-dir': 'deploy/.managed/../elsewhere' }),
    ).toThrow();
    expect(() => parseSetupArguments(['--password=do-not-log-me'])).toThrow(
      'Unknown setup option',
    );
    expect(() => parseSetupArguments(['--local', '--local'])).toThrow(
      'Duplicate option',
    );
    expect(
      parseSetupArguments(['status', '--local', '--project', 'wo-test']),
    ).toMatchObject({ action: 'status', local: true, project: 'wo-test' });
  });

  it('keeps production provenance strict and rejects a changed source revision before startup', async () => {
    const root = await workspace();
    const provenance = {
      BUILD_CREATED: '2026-09-12T00:00:00Z',
      BUILD_REVISION: 'a'.repeat(40),
      BUILD_VERSION: `2026.09.12-${'a'.repeat(12)}`,
      SOURCE_DATE_EPOCH: '1789171200',
    };
    const options = {
      action: 'configure',
      'non-interactive': true,
      project: 'wo-production',
      domain: 'rtc.real-domain.com',
      email: 'owner@real-domain.com',
      'admin-email': 'admin@real-domain.com',
      'public-ip': '8.8.8.8',
    };
    await expect(
      configureSetup(options, {
        root,
        platform: 'win32',
        provenanceProvider: () => provenance,
      }),
    ).rejects.toThrow('Linux Docker host');
    const configured = await configureSetup(options, {
      root,
      platform: 'linux',
      provenanceProvider: () => provenance,
    });
    expect(configured.environment.WO_TLS_MODE).toBe('acme');
    await expect(
      configureSetup(
        { ...options, action: 'up' },
        {
          root,
          platform: 'linux',
          provenanceProvider: () => ({
            ...provenance,
            BUILD_REVISION: 'b'.repeat(40),
          }),
        },
      ),
    ).rejects.toThrow('revision differs');
  });

  it('refreshes only an unfinished production build and preserves identity, credentials and interrupted refresh recovery', async () => {
    const root = await workspace();
    const original = {
      BUILD_CREATED: '2026-09-12T00:00:00Z',
      BUILD_REVISION: 'a'.repeat(40),
      BUILD_VERSION: `2026.09.12-${'a'.repeat(12)}`,
      SOURCE_DATE_EPOCH: '1789171200',
    };
    const updated = {
      ...original,
      BUILD_REVISION: 'b'.repeat(40),
      BUILD_VERSION: `2026.09.12-${'b'.repeat(12)}`,
    };
    const options = {
      action: 'configure',
      'non-interactive': true,
      project: 'wo-refresh',
      domain: 'rtc.example.com',
      email: 'owner@example.com',
      'admin-email': 'admin@example.com',
      'public-ip': '8.8.8.8',
    };
    const first = await configureSetup(options, {
      root,
      platform: 'linux',
      provenanceProvider: () => original,
    });
    const protectedFiles = [
      'first-login.txt',
      'secrets/bootstrap_admin_password',
      'secrets/jwt_access_secret',
      'secrets/postgres_password',
      'secrets/turn_shared_secret',
    ];
    const before = await Promise.all(
      protectedFiles.map((file) =>
        readFile(join(first.stateDirectory, file), 'utf8'),
      ),
    );
    const oldEnvironment = await readFile(first.envFile, 'utf8');
    const refreshOptions = { ...options, action: 'up', 'refresh-build': true };
    const dependencies = {
      root,
      platform: 'linux',
      provenanceProvider: () => updated,
    };
    const refreshed = await configureSetup(refreshOptions, dependencies);
    expect(refreshed.provenance).toEqual(updated);
    expect(refreshed.environment.WO_DEPLOYMENT_ID).toBe(
      first.environment.WO_DEPLOYMENT_ID,
    );
    expect(
      parseDotEnv(await readFile(first.envFile, 'utf8')).BUILD_REVISION,
    ).toBe(updated.BUILD_REVISION);
    expect(
      await Promise.all(
        protectedFiles.map((file) =>
          readFile(join(first.stateDirectory, file), 'utf8'),
        ),
      ),
    ).toEqual(before);
    // Simulate interruption after saving the new manifest but before its env file.
    await writeFile(first.envFile, oldEnvironment);
    await configureSetup(refreshOptions, dependencies);
    expect(
      parseDotEnv(await readFile(first.envFile, 'utf8')).BUILD_REVISION,
    ).toBe(updated.BUILD_REVISION);
    await expect(
      configureSetup(
        { ...refreshOptions, domain: 'other.example.com' },
        dependencies,
      ),
    ).rejects.toThrow('Configuration differs');
    await writeFile(
      first.envFile,
      (await readFile(first.envFile, 'utf8')).replace(
        'rtc.example.com',
        'injected.example.com',
      ),
    );
    await expect(configureSetup(refreshOptions, dependencies)).rejects.toThrow(
      'Build refresh cannot change',
    );
    await writeFile(first.envFile, oldEnvironment);
    await configureSetup(refreshOptions, dependencies);
    await writeFile(join(first.stateDirectory, 'started.json'), '{}');
    await expect(configureSetup(refreshOptions, dependencies)).rejects.toThrow(
      'unfinished production',
    );
  });

  it('keeps Docker Desktop runtime discovery while excluding ambient app and Compose overrides', async () => {
    const root = await workspace();
    const setup = await configureSetup(
      { action: 'configure', local: true },
      { root },
    );
    const command = managedComposeArguments(setup, 'config', '--quiet');
    expect(command.slice(0, 3)).toEqual([
      'compose',
      '--project-name',
      'wo-local',
    ]);
    const environment = managedProcessEnvironment(command, {
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\operator',
      BUILD_VERSION: 'injected',
      APP_DOMAIN: 'injected',
      SMTP_PASS: 'sensitive',
      PATH: 'runtime-path',
      COMPOSE_FILE: 'other.yaml',
    });
    expect(environment).toMatchObject({
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\operator',
      PATH: 'runtime-path',
    });
    expect(environment).not.toHaveProperty('BUILD_VERSION');
    expect(environment).not.toHaveProperty('APP_DOMAIN');
    expect(environment).not.toHaveProperty('SMTP_PASS');
    expect(environment).not.toHaveProperty('COMPOSE_FILE');
  });

  it('rejects existing containers and orphaned volumes from a different installation', async () => {
    const root = await workspace();
    const setup = await configureSetup(
      { action: 'configure', local: true },
      { root },
    );
    const sameOwner = (args: string[]) =>
      args[0] === 'ps'
        ? 'a'.repeat(64)
        : args[1] === 'ls'
          ? 'wo-local_postgres_data'
          : setup.deploymentId;
    expect(() =>
      verifyManagedResourceOwnership(setup, sameOwner),
    ).not.toThrow();
    expect(() =>
      verifyManagedResourceOwnership(setup, (args: string[]) =>
        args[0] === 'ps' ? 'b'.repeat(64) : '<no value>',
      ),
    ).toThrow('another deployment');
    expect(() =>
      verifyManagedResourceOwnership(setup, (args: string[]) =>
        args[0] === 'ps'
          ? ''
          : args[1] === 'ls'
            ? 'wo-local_postgres_data'
            : 'other-owner',
      ),
    ).toThrow('another deployment');
    const again = await configureSetup(
      { action: 'configure', local: true },
      { root },
    );
    expect(again.deploymentId).toBe(setup.deploymentId);
  });

  it('checks public DNS before ACME startup and skips public lookup for local mode', async () => {
    const environment = {
      WO_TLS_MODE: 'acme',
      APP_DOMAIN: 'rtc.real-domain.com',
      PUBLIC_IPV4: '8.8.8.8',
    };
    await expect(
      verifyManagedDns(environment, async () => ['8.8.8.8']),
    ).resolves.toBeUndefined();
    await expect(
      verifyManagedDns(environment, async () => ['1.1.1.1']),
    ).rejects.toThrow('DNS A records');
    await expect(
      verifyManagedDns(environment, async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow('no resolvable DNS');
    await expect(
      verifyManagedDns({ ...environment, WO_TLS_MODE: 'local' }, async () => {
        throw new Error('should not query');
      }),
    ).resolves.toBeUndefined();
  });
});
