import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  applyExternalDatabaseRelease,
  applyRelease,
  releaseProfile,
} from '../../deploy/scripts/apply-release.mjs';

const provenance = Object.freeze({
  BUILD_CREATED: '2026-07-25T00:00:00Z',
  BUILD_REVISION: 'b88a10f0867cfe349689269407145e8c7ff6afe5',
  BUILD_VERSION: '2026.07.25-b88a10f0867c',
  SOURCE_DATE_EPOCH: '1784917907',
});

function imageId(character: string) {
  return `sha256:${character.repeat(64)}`;
}

const images = Object.freeze({
  coturn: Object.freeze({ imageId: imageId('b') }),
  server: Object.freeze({ imageId: imageId('a') }),
});
const secretDirectory = '/opt/wo/deploy/secrets';
const smokeEmails =
  'smoke-one@example.test,smoke-two@example.test,smoke-three@example.test';
const postgresSystemIdentifier = '7490136767012577314';
const ingressContainerId = 'e'.repeat(64);
const ingressImageId = imageId('e');
const serverComposeConfigHash = '9'.repeat(64);

const applyDependencies = Object.freeze({
  assertRollbackRoot: async (directory: string) => directory,
  loadReleaseBundle: async () => ({ images }),
  readReleaseBundle: async () => ({ manifest: { provenance } }),
});

type Service = 'coturn' | 'postgres' | 'server';

type CommandCall = {
  arguments_: string[];
  command: string;
  label: string;
};

type InspectionOverride = {
  health?: string;
  imageId?: string;
  running?: boolean;
};

type HarnessOptions = {
  cleanupFailure?: Service;
  cleanupLookupFailure?: Service;
  cleanupRemaining?: Service;
  cleanupThrownValue?: unknown;
  failSmoke?: boolean;
  inspections?: Partial<Record<Service, InspectionOverride>>;
  postgresImageMissing?: boolean;
  postgresExisted?: boolean;
  releaseServicesExisted?: boolean;
  rootBoundaryInvalid?: boolean;
  rootSecretBoundaryInvalid?: boolean;
  smokeThrownValue?: unknown;
};

function releaseApplyOverrideNames(call: CommandCall) {
  const commandIndex = call.arguments_.findIndex((argument) =>
    ['config', 'rm', 'up'].includes(argument),
  );
  return call.arguments_
    .slice(0, commandIndex)
    .flatMap((argument, index, arguments_) =>
      argument === '-f' ? [arguments_[index + 1]] : [],
    )
    .filter(
      (file): file is string =>
        file?.endsWith('/release.compose.yaml') === true ||
        file?.endsWith('/postgres.compose.yaml') === true,
    )
    .map((file) => file.split('/').at(-1));
}

function renderedRootConfiguration(managesPostgres: boolean) {
  return {
    name: 'wo',
    secrets: Object.fromEntries(
      [
        ['jwt_access_secret', 'jwt_access_secret'],
        ['postgres_password', 'postgres_password'],
        ['turn_shared_secret', 'turn_shared_secret'],
        ['turn_tls_cert', 'turn_tls_cert.pem'],
        ['turn_tls_key', 'turn_tls_key.pem'],
      ].map(([name, file]) => [
        name,
        { file: resolve(secretDirectory, file!) },
      ]),
    ),
    services: {
      coturn: {
        environment: {
          TURN_EXTERNAL_IP: '203.0.113.10',
          TURN_INTERNAL_IP: '',
          TURN_REALM: 'turn.example.test',
          TURN_RELAY_MAX_PORT: '49200',
          TURN_RELAY_MIN_PORT: '49160',
        },
        image: images.coturn.imageId,
        networks: { turn_edge: null },
        platform: 'linux/amd64',
        ports: [{ host_ip: '0.0.0.0' }],
        pull_policy: 'never',
      },
      ...(managesPostgres
        ? {
            postgres: {
              image: 'postgres:17.10-alpine3.23',
              platform: 'linux/amd64',
            },
          }
        : {}),
      server: {
        ...(managesPostgres
          ? {
              depends_on: {
                postgres: { condition: 'service_healthy' },
              },
            }
          : {}),
        environment: {
          POSTGRES_DB: 'wo',
          POSTGRES_HOST: managesPostgres ? 'postgres' : 'db.example.test',
          POSTGRES_PORT: '5432',
          POSTGRES_USER: 'wo',
        },
        image: images.server.imageId,
        networks: { edge: null },
        platform: 'linux/amd64',
        ports: [{ host_ip: '127.0.0.1' }],
        pull_policy: 'never',
      },
    },
  };
}

function createHarness(harnessOptions: HarnessOptions = {}) {
  const {
    cleanupFailure,
    cleanupLookupFailure,
    cleanupRemaining,
    cleanupThrownValue,
    failSmoke = false,
    inspections = {},
    postgresImageMissing = false,
    postgresExisted = false,
    releaseServicesExisted = false,
    rootBoundaryInvalid = false,
    rootSecretBoundaryInvalid = false,
    smokeThrownValue,
  } = harnessOptions;
  const calls: CommandCall[] = [];
  const execute = (
    command: string,
    arguments_: string[],
    options: { label?: string } = {},
  ) => {
    const label = options.label ?? '';
    calls.push({ arguments_: [...arguments_], command, label });
    const service = label.split(' ')[0] as Service;

    if (label.endsWith('existing container lookup')) {
      if (service === 'postgres' && postgresExisted) {
        return 'postgres-existing';
      }
      return releaseServicesExisted && ['server', 'coturn'].includes(service)
        ? `${service}-existing`
        : '';
    }
    if (label.endsWith('activated container lookup')) {
      return `${service}-activated`;
    }
    if (label.endsWith('activated container inspection')) {
      const override = inspections[service] ?? {};
      return JSON.stringify({
        Image:
          override.imageId ??
          (service === 'postgres' ? imageId('c') : images[service].imageId),
        State: {
          Health: { Status: override.health ?? 'healthy' },
          Running: override.running ?? true,
        },
      });
    }
    if (label === 'Release Compose validation') {
      const managesPostgres = arguments_.some((argument) =>
        argument.endsWith('/docker-compose.yml'),
      );
      const configuration = renderedRootConfiguration(managesPostgres);
      if (
        managesPostgres &&
        arguments_.some((argument) =>
          argument.endsWith('/postgres.compose.yaml'),
        )
      ) {
        configuration.services.postgres.image = imageId('c');
        configuration.services.postgres.pull_policy = 'never';
      }
      if (rootBoundaryInvalid) {
        configuration.services.server.image = imageId('f');
      }
      if (rootSecretBoundaryInvalid) {
        configuration.secrets.turn_tls_key.file =
          '/tmp/unvalidated/turn_tls_key.pem';
      }
      return JSON.stringify(configuration);
    }
    if (label === 'PostgreSQL image prerequisite') {
      if (postgresImageMissing) {
        throw new Error('configured PostgreSQL image is absent');
      }
      return imageId('c');
    }
    if (label === 'Server rollback Compose runtime equivalence') {
      return `server ${serverComposeConfigHash}`;
    }
    if (label === 'Post-apply internal smoke' && failSmoke) {
      if (Object.hasOwn(harnessOptions, 'smokeThrownValue')) {
        throw smokeThrownValue;
      }
      throw new Error('focused smoke failure');
    }
    if (label === `${cleanupFailure} initial cleanup`) {
      if (Object.hasOwn(harnessOptions, 'cleanupThrownValue')) {
        throw cleanupThrownValue;
      }
      throw new Error(`${cleanupFailure} removal failure`);
    }
    if (label.endsWith('post-cleanup container lookup')) {
      if (service === cleanupLookupFailure) {
        if (Object.hasOwn(harnessOptions, 'cleanupThrownValue')) {
          throw cleanupThrownValue;
        }
        throw new Error(`${cleanupLookupFailure} lookup failure`);
      }
      return service === cleanupRemaining ? `${service}-remaining` : '';
    }
    return '';
  };
  return { calls, execute };
}

const temporaryDirectories: string[] = [];

async function createFixture(
  profileName: 'external-db' | 'root-managed-db',
  execute: ReturnType<typeof createHarness>['execute'],
  environmentOverrides: Record<string, string> = {},
) {
  const rollbackRoot = await mkdtemp(
    resolve(tmpdir(), 'wo-apply-release-safety-'),
  );
  temporaryDirectories.push(rollbackRoot);
  await chmod(rollbackRoot, 0o700);
  const envFile = resolve(rollbackRoot, '.env');
  await writeFile(
    envFile,
    `${Object.entries({
      DEPLOY_SECRET_DIR: secretDirectory,
      DEPLOY_SMOKE_EMAILS: smokeEmails,
      DEPLOY_SMOKE_PASSWORD: 'correct-horse-battery-staple',
      EMAIL_DOMAIN_ALLOWLIST: 'example.test',
      EMAIL_VERIFICATION_REQUIRED: 'true',
      POSTGRES_DB: 'wo',
      POSTGRES_HOST: 'db.example.test',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'wo',
      PUBLIC_IPV4: '203.0.113.10',
      TURN_NETWORK_MODE: 'bridge',
      TURN_REALM: 'turn.example.test',
      TURN_RELAY_MAX_PORT: '49200',
      TURN_RELAY_MIN_PORT: '49160',
      TURN_PORT: '3478',
      TURN_TLS_PORT: '5349',
      WO_HTTP_PORT: '18080',
      ...environmentOverrides,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
  return {
    dependencies: {
      ...applyDependencies,
      operationLockRoot: rollbackRoot,
    },
    envFile,
    options: {
      confirmApply: true,
      envFile,
      execute,
      expectedManifestSha256: 'd'.repeat(64),
      manifestFile: resolve(rollbackRoot, 'release-manifest.json'),
      mode: 'initial',
      profileName,
      rollbackRoot,
    },
    rollbackRoot,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('release apply activation safety', () => {
  test('runs production preflight and root Compose validation before bootstrapping PostgreSQL first', async () => {
    const harness = createHarness();
    const fixture = await createFixture('root-managed-db', harness.execute);

    await applyRelease(fixture.options, fixture.dependencies);

    const labels = harness.calls.map(({ label }) => label);
    const preflightIndex = labels.indexOf('Production preflight');
    const composeValidationIndexes = labels.flatMap((label, index) =>
      label === 'Release Compose validation' ? [index] : [],
    );
    const composeValidationIndex = composeValidationIndexes[0];
    const immutableComposeValidationIndex = composeValidationIndexes[1];
    const postgresIndex = labels.indexOf('PostgreSQL bootstrap');
    const postgresPrerequisiteIndex = labels.indexOf(
      'PostgreSQL image prerequisite',
    );
    const postgresInspectionIndex = labels.indexOf(
      'postgres activated container inspection',
    );
    const releaseIndex = labels.indexOf('Release activation');
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(composeValidationIndexes).toHaveLength(2);
    expect(composeValidationIndex).toBeGreaterThan(preflightIndex);
    expect(postgresPrerequisiteIndex).toBeGreaterThan(composeValidationIndex);
    expect(immutableComposeValidationIndex).toBeGreaterThan(
      postgresPrerequisiteIndex,
    );
    expect(postgresIndex).toBeGreaterThan(immutableComposeValidationIndex);
    expect(postgresInspectionIndex).toBeGreaterThan(postgresIndex);
    expect(releaseIndex).toBeGreaterThan(postgresInspectionIndex);

    const preflight = harness.calls[preflightIndex];
    expect(preflight.command).toBe(process.execPath);
    expect(preflight.arguments_).toEqual(
      expect.arrayContaining([
        `--env-file=${fixture.envFile}`,
        '--allow-running',
      ]),
    );

    const composeValidation = harness.calls[composeValidationIndex];
    expect(composeValidation.arguments_).toEqual(
      expect.arrayContaining(['-f', 'config', '--format', 'json']),
    );
    expect(
      composeValidation.arguments_.some((argument) =>
        argument.endsWith('/release.compose.yaml'),
      ),
    ).toBe(true);
    expect(releaseApplyOverrideNames(composeValidation)).toEqual([
      'release.compose.yaml',
    ]);
    const immutableComposeValidation =
      harness.calls[immutableComposeValidationIndex];
    expect(releaseApplyOverrideNames(immutableComposeValidation)).toEqual([
      'release.compose.yaml',
      'postgres.compose.yaml',
    ]);

    const postgres = harness.calls[postgresIndex];
    expect(postgres.arguments_).toEqual(
      expect.arrayContaining(['--no-build', '--pull', 'never']),
    );
    expect(postgres.arguments_).not.toContain('--force-recreate');
    expect(postgres.arguments_.at(-1)).toBe('postgres');
    expect(releaseApplyOverrideNames(postgres)).toEqual([
      'release.compose.yaml',
      'postgres.compose.yaml',
    ]);

    const release = harness.calls[releaseIndex];
    expect(release.arguments_).toContain('--force-recreate');
    expect(release.arguments_.slice(-2)).toEqual(['server', 'coturn']);
    expect(releaseApplyOverrideNames(release)).toEqual([
      'release.compose.yaml',
      'postgres.compose.yaml',
    ]);
    await expect(
      stat(resolve(fixture.rollbackRoot, '.wo-release-apply.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('never references PostgreSQL for the external database profile', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);

    await applyRelease(fixture.options, fixture.dependencies);

    expect(
      harness.calls.some(
        ({ arguments_, label }) =>
          label.toLowerCase().includes('postgres') ||
          arguments_.includes('postgres'),
      ),
    ).toBe(false);
    expect(
      harness.calls
        .find(({ label }) => label === 'Release activation')
        ?.arguments_.slice(-2),
    ).toEqual(['server', 'coturn']);
    expect(
      releaseApplyOverrideNames(
        harness.calls.find(({ label }) => label === 'Release activation')!,
      ),
    ).toEqual(['release.compose.yaml']);
  });

  test('rejects an exited container and removes every newly activated root service', async () => {
    const harness = createHarness({
      inspections: { server: { running: false } },
    });
    const fixture = await createFixture('root-managed-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/server activated container is not running/i);

    expect(
      harness.calls
        .filter(({ label }) => label.endsWith('initial cleanup'))
        .map(({ label }) => label),
    ).toEqual([
      'server initial cleanup',
      'coturn initial cleanup',
      'postgres initial cleanup',
    ]);
    for (const cleanup of harness.calls.filter(({ label }) =>
      label.endsWith('initial cleanup'),
    )) {
      expect(cleanup.arguments_).toEqual(
        expect.arrayContaining(['rm', '--stop', '--force']),
      );
      expect(releaseApplyOverrideNames(cleanup)).toEqual([
        'release.compose.yaml',
        'postgres.compose.yaml',
      ]);
    }
  });

  test('rejects an unhealthy running container', async () => {
    const harness = createHarness({
      inspections: { server: { health: 'unhealthy' } },
    });
    const fixture = await createFixture('external-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/server activated container health status is unhealthy/i);
  });

  test('rejects a healthy container using any image other than the verified image ID', async () => {
    const harness = createHarness({
      inspections: { server: { imageId: imageId('f') } },
    });
    const fixture = await createFixture('external-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/does not use the verified image ID/i);
  });

  test('preserves a PostgreSQL container that existed before a failed attempt', async () => {
    const harness = createHarness({
      failSmoke: true,
      postgresExisted: true,
    });
    const fixture = await createFixture('root-managed-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/focused smoke failure/i);

    expect(
      harness.calls
        .filter(({ label }) => label.endsWith('initial cleanup'))
        .map(({ label }) => label),
    ).toEqual(['server initial cleanup', 'coturn initial cleanup']);
    expect(
      harness.calls.some(({ label }) => label === 'PostgreSQL bootstrap'),
    ).toBe(false);
    expect(
      harness.calls.some(
        ({ arguments_, label }) =>
          label === 'postgres activated container inspection' &&
          !arguments_.includes('up'),
      ),
    ).toBe(true);
  });

  test('formats a non-coercible apply failure after completing every activation cleanup', async () => {
    const smokeFailure = Object.create(null);
    const harness = createHarness({
      failSmoke: true,
      smokeThrownValue: smokeFailure,
    });
    const fixture = await createFixture('external-db', harness.execute);
    let failure: unknown;

    try {
      await applyRelease(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/Unprintable error/);
    expect((failure as Error & { cause?: unknown }).cause).toBe(smokeFailure);
    expect(
      harness.calls
        .filter(({ label }) => label.endsWith('initial cleanup'))
        .map(({ label }) => label),
    ).toEqual(['server initial cleanup', 'coturn initial cleanup']);
  });

  test('fails selected root profile boundary validation before any activation', async () => {
    const harness = createHarness({ rootBoundaryInvalid: true });
    const fixture = await createFixture('external-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/root Compose preflight failed.*not immutable/i);
    expect(
      harness.calls.some(
        ({ arguments_ }) =>
          arguments_.includes('up') || arguments_.includes('rm'),
      ),
    ).toBe(false);
    expect(
      (await readdir(fixture.rollbackRoot, { withFileTypes: true })).some(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith('wo-release-apply-'),
      ),
    ).toBe(false);
  });

  test('preserves a pre-activation failure as the cause when workspace cleanup also fails', async () => {
    const harness = createHarness({ rootBoundaryInvalid: true });
    const fixture = await createFixture('external-db', harness.execute);
    const cleanupFailure = new Error('workspace cleanup failed');
    let failure: unknown;

    try {
      await applyRelease(fixture.options, {
        ...fixture.dependencies,
        removeDirectory: async (directory: string) => {
          if (
            directory.startsWith(
              resolve(fixture.rollbackRoot, 'wo-release-apply-'),
            )
          ) {
            throw cleanupFailure;
          }
          await rm(directory, { force: true, recursive: true });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toMatchObject({
      message: expect.stringMatching(/root Compose preflight failed/i),
    });
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
  });

  test('rejects a rendered secret outside the absolute preflight directory before activation', async () => {
    const harness = createHarness({ rootSecretBoundaryInvalid: true });
    const fixture = await createFixture('external-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(
      /root Compose preflight failed.*turn_tls_key.*absolute preflight directory/i,
    );
    expect(
      harness.calls.some(({ arguments_ }) => arguments_.includes('up')),
    ).toBe(false);
  });

  test('rejects a relative secret directory and missing smoke accounts before preflight', async () => {
    for (const environmentOverrides of [
      { DEPLOY_SECRET_DIR: './secrets' },
      { DEPLOY_SMOKE_EMAILS: '' },
    ]) {
      const harness = createHarness();
      const fixture = await createFixture(
        'external-db',
        harness.execute,
        environmentOverrides,
      );

      await expect(
        applyRelease(fixture.options, fixture.dependencies),
      ).rejects.toThrow(
        /DEPLOY_SECRET_DIR must be an absolute path|DEPLOY_SMOKE_EMAILS must contain exactly three unique accounts/i,
      );
      expect(harness.calls).toEqual([]);
    }
  });

  test('requires the configured PostgreSQL image to exist locally before bootstrap', async () => {
    const harness = createHarness({ postgresImageMissing: true });
    const fixture = await createFixture('root-managed-db', harness.execute);

    await expect(
      applyRelease(fixture.options, fixture.dependencies),
    ).rejects.toThrow(/configured PostgreSQL image is absent/i);
    expect(
      harness.calls.some(({ arguments_ }) => arguments_.includes('up')),
    ).toBe(false);
    expect(
      (await readdir(fixture.rollbackRoot, { withFileTypes: true })).some(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith('wo-release-apply-'),
      ),
    ).toBe(false);
  });

  test('aggregates cleanup failures, still attempts coturn removal, and retains the workspace', async () => {
    const harness = createHarness({
      cleanupFailure: 'server',
      failSmoke: true,
    });
    const fixture = await createFixture('external-db', harness.execute);

    let failure: unknown;
    try {
      await applyRelease(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect((aggregate.errors as Error[]).map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        'focused smoke failure',
        expect.stringMatching(/server initial cleanup failed/i),
      ]),
    );
    const cleanupLabels = harness.calls
      .filter(({ label }) => label.endsWith('initial cleanup'))
      .map(({ label }) => label);
    expect(cleanupLabels).toEqual([
      'server initial cleanup',
      'coturn initial cleanup',
    ]);
    expect(
      (await readdir(fixture.rollbackRoot, { withFileTypes: true })).some(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith('wo-release-apply-'),
      ),
    ).toBe(true);
  });

  test('formats non-coercible cleanup failures and continues through every service', async () => {
    const cleanupFailure = Object.create(null);
    const harness = createHarness({
      cleanupFailure: 'server',
      cleanupLookupFailure: 'coturn',
      cleanupThrownValue: cleanupFailure,
      failSmoke: true,
    });
    const fixture = await createFixture('external-db', harness.execute);
    let failure: unknown;

    try {
      await applyRelease(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    const cleanupErrors = aggregate.errors.slice(1) as Array<
      Error & { cause?: unknown }
    >;
    expect(cleanupErrors.map(({ message }) => message)).toEqual([
      'server initial cleanup failed: Unprintable error',
      'coturn initial cleanup verification failed: Unprintable error',
    ]);
    expect(cleanupErrors.every(({ cause }) => cause === cleanupFailure)).toBe(
      true,
    );
    expect(
      harness.calls
        .filter(({ label }) => label.endsWith('initial cleanup'))
        .map(({ label }) => label),
    ).toEqual(['server initial cleanup', 'coturn initial cleanup']);
  });

  test('treats a coturn container remaining after cleanup as an aggregate failure', async () => {
    const harness = createHarness({
      cleanupRemaining: 'coturn',
      failSmoke: true,
    });
    const fixture = await createFixture('external-db', harness.execute);

    let failure: unknown;
    try {
      await applyRelease(fixture.options, fixture.dependencies);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      ((failure as AggregateError).errors as Error[]).map(
        ({ message }) => message,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /coturn initial cleanup verification failed.*remains after cleanup/i,
        ),
      ]),
    );
  });

  test('rejects root-managed upgrade before reading environment, bundle, or Docker', async () => {
    let commandExecuted = false;

    await expect(
      applyRelease({
        confirmApply: true,
        envFile: '/unused/.env',
        execute: () => {
          commandExecuted = true;
          return '';
        },
        expectedManifestSha256: 'e'.repeat(64),
        manifestFile: '/unused/release-manifest.json',
        mode: 'upgrade',
        profileName: 'root-managed-db',
        rollbackRoot: '/unused/rollback',
      }),
    ).rejects.toThrow(/supported only for the external-db profile/i);
    expect(commandExecuted).toBe(false);
  });

  test('requires an explicitly pinned external PostgreSQL target before invoking Docker', async () => {
    const harness = createHarness({ releaseServicesExisted: true });
    const fixture = await createFixture('external-db', harness.execute);

    await expect(
      applyRelease(
        { ...fixture.options, mode: 'upgrade' },
        fixture.dependencies,
      ),
    ).rejects.toThrow(
      /external database upgrade requires.*external-postgres-container-id/i,
    );
    expect(harness.calls).toEqual([]);
  });

  test('requires a pinned external ingress target before invoking Docker', async () => {
    const harness = createHarness({ releaseServicesExisted: true });
    const fixture = await createFixture('external-db', harness.execute);

    await expect(
      applyRelease(
        {
          ...fixture.options,
          expectedPostgresMajor: 17,
          expectedPostgresSystemIdentifier: postgresSystemIdentifier,
          externalPostgresAdmin: 'release_admin',
          externalPostgresContainerId: 'a'.repeat(64),
          mode: 'upgrade',
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow(
      /external database upgrade requires.*external-ingress-container-id.*expected-ingress-image-id/i,
    );
    expect(harness.calls).toEqual([]);
  });

  test('rejects malformed external ingress identities before invoking Docker', async () => {
    for (const [
      externalIngressContainerId,
      expectedIngressImageId,
      pattern,
    ] of [
      [
        'short-container-id',
        ingressImageId,
        /external-ingress-container-id must be a complete container ID/i,
      ],
      [
        ingressContainerId,
        'mutable-ingress-reference',
        /expected-ingress-image-id is invalid/i,
      ],
    ] as const) {
      const harness = createHarness({ releaseServicesExisted: true });
      const fixture = await createFixture('external-db', harness.execute);

      await expect(
        applyRelease(
          {
            ...fixture.options,
            expectedIngressImageId,
            expectedPostgresMajor: 17,
            expectedPostgresSystemIdentifier: postgresSystemIdentifier,
            externalIngressContainerId,
            externalPostgresAdmin: 'release_admin',
            externalPostgresContainerId: 'a'.repeat(64),
            mode: 'upgrade',
          },
          fixture.dependencies,
        ),
      ).rejects.toThrow(pattern);
      expect(harness.calls).toEqual([]);
    }
  });

  test('delegates a pinned external database upgrade after bundle and running-state preflight', async () => {
    const harness = createHarness({ releaseServicesExisted: true });
    const fixture = await createFixture('external-db', harness.execute);
    let delegated:
      Parameters<typeof applyExternalDatabaseRelease>[0] | undefined;

    await applyRelease(
      {
        ...fixture.options,
        expectedIngressImageId: ingressImageId,
        expectedPostgresMajor: 17,
        expectedPostgresSystemIdentifier: postgresSystemIdentifier,
        externalIngressContainerId: ingressContainerId,
        externalPostgresAdmin: 'release_admin',
        externalPostgresContainerId: 'a'.repeat(64),
        mode: 'upgrade',
      },
      {
        ...fixture.dependencies,
        applyExternalRelease: async (options) => {
          delegated = options;
          return { backupDirectory: '/safe/external-db-backup' };
        },
      },
    );

    expect(delegated).toMatchObject({
      canonicalRollbackRoot: fixture.rollbackRoot,
      expectedIngressImageId: ingressImageId,
      expectedPostgresMajor: 17,
      expectedPostgresSystemIdentifier: postgresSystemIdentifier,
      ingressContainerId,
      postgresAdmin: 'release_admin',
      postgresContainerId: 'a'.repeat(64),
      profile: { managesPostgres: false },
      provenance,
      resolvedEnvFile: fixture.envFile,
    });
    expect(
      harness.calls
        .filter(({ label }) => label.endsWith('existing container lookup'))
        .map(({ arguments_, label }) => ({ arguments_, label })),
    ).toEqual([
      expect.objectContaining({
        arguments_: expect.arrayContaining(['ps', '--all', '-q', 'server']),
        label: 'server existing container lookup',
      }),
      expect.objectContaining({
        arguments_: expect.arrayContaining(['ps', '--all', '-q', 'coturn']),
        label: 'coturn existing container lookup',
      }),
    ]);
    expect(
      harness.calls.some(({ label }) => label === 'Production preflight'),
    ).toBe(true);
    await expect(
      stat(resolve(fixture.rollbackRoot, '.wo-release-apply.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('captures and leases old images before loading the external database release', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);
    const workspace = resolve(fixture.rollbackRoot, 'upgrade-workspace');
    await mkdir(workspace, { mode: 0o700 });
    const order: string[] = [];
    const capturedImages = {
      coturn: {
        composeConfigHash: '8'.repeat(64),
        containerId: 'old-coturn',
        imageId: imageId('2'),
        imageReference: 'wo-coturn:old',
      },
      server: {
        composeConfigHash: serverComposeConfigHash,
        containerId: 'old-server',
        imageId: imageId('1'),
        imageReference: 'wo-server:old',
      },
    };
    const leasedImages = {
      coturn: {
        ...capturedImages.coturn,
        leaseReference: 'wo-rollback-lease:test-coturn',
      },
      server: {
        ...capturedImages.server,
        leaseReference: 'wo-rollback-lease:test-server',
      },
    };

    const result = await applyExternalDatabaseRelease(
      {
        canonicalRollbackRoot: fixture.rollbackRoot,
        environment: {
          DEPLOY_SECRET_DIR: secretDirectory,
          POSTGRES_DB: 'wo',
          POSTGRES_HOST: 'db.example.test',
          POSTGRES_PORT: '5432',
          POSTGRES_USER: 'wo',
          PUBLIC_IPV4: '203.0.113.10',
          TURN_NETWORK_MODE: 'bridge',
          TURN_REALM: 'turn.example.test',
          TURN_RELAY_MAX_PORT: '49200',
          TURN_RELAY_MIN_PORT: '49160',
        },
        execute: harness.execute,
        expectedIngressImageId: ingressImageId,
        expectedManifestSha256: 'd'.repeat(64),
        expectedPostgresMajor: 17,
        expectedPostgresSystemIdentifier: postgresSystemIdentifier,
        ingressContainerId,
        manifestFile: fixture.options.manifestFile,
        postgresAdmin: 'release_admin',
        postgresContainerId: 'a'.repeat(64),
        profile: releaseProfile('external-db'),
        provenance,
        resolvedEnvFile: fixture.envFile,
      },
      {
        acquireImageLeases: (captured, options) => {
          order.push(`lease:${options.selectedServices?.join(',')}`);
          expect(captured).toBe(capturedImages);
          return leasedImages;
        },
        captureImages: (_envFile, options) => {
          order.push(`capture:${options.selectedServices?.join(',')}`);
          expect(
            options.composeArgumentsForProfile?.(
              fixture.envFile,
              'ps',
              '-q',
              'server',
            ),
          ).toEqual(
            expect.arrayContaining([
              expect.stringMatching(/docker-compose\.external-db\.yml$/u),
              'server',
            ]),
          );
          return capturedImages;
        },
        createWorkspace: async (_images, options) => {
          order.push(`workspace:${options.selectedServices?.join(',')}`);
          return {
            directory: workspace,
            override: resolve(workspace, 'rollback.compose.yaml'),
          };
        },
        loadReleaseBundle: async () => {
          order.push('load-bundle');
          return { images };
        },
        releaseResources: async (directory, rollback, retain, options) => {
          order.push(
            `release:${retain}:${options.selectedServices?.join(',')}`,
          );
          expect(directory).toBe(workspace);
          expect(rollback).toBe(leasedImages);
          return true;
        },
        runDatabaseUpgrade: async (options) => {
          order.push('database-upgrade');
          expect(options).toMatchObject({
            applicationRole: 'wo',
            backupRoot: fixture.rollbackRoot,
            databaseName: 'wo',
            expectedIngressImageId: ingressImageId,
            ingressContainerId,
            releaseImages: images,
            rollbackImages: leasedImages,
            workspace,
          });
          return { backupDirectory: '/safe/external-db-backup' };
        },
      },
    );

    expect(result).toEqual({
      backupDirectory: '/safe/external-db-backup',
    });
    expect(order).toEqual([
      'capture:server,coturn',
      'lease:server,coturn',
      'workspace:server,coturn',
      'load-bundle',
      'database-upgrade',
      'release:false:server,coturn',
    ]);
    expect(
      harness.calls.find(
        ({ label }) => label === 'Server rollback Compose runtime equivalence',
      ),
    ).toMatchObject({
      arguments_: expect.arrayContaining([
        '-f',
        resolve(workspace, 'rollback.compose.yaml'),
        '-f',
        resolve(workspace, 'rollback-equivalence.compose.yaml'),
        'config',
        '--hash',
        'server',
      ]),
      command: 'docker',
    });
    expect(
      await readFile(
        resolve(workspace, 'rollback-equivalence.compose.yaml'),
        'utf8',
      ),
    ).toBe(
      [
        'services:',
        '  server:',
        `    image: ${JSON.stringify(leasedImages.server.imageReference)}`,
        '',
      ].join('\n'),
    );
  });

  test('retains workspace and image leases when external database rollback is incomplete', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);
    const workspace = resolve(fixture.rollbackRoot, 'retained-workspace');
    await mkdir(workspace, { mode: 0o700 });
    const primary = Object.assign(new Error('rollback incomplete'), {
      retainRollbackResources: true,
    });
    let retain: boolean | undefined;

    await expect(
      applyExternalDatabaseRelease(
        {
          canonicalRollbackRoot: fixture.rollbackRoot,
          environment: {
            DEPLOY_SECRET_DIR: secretDirectory,
            POSTGRES_DB: 'wo',
            POSTGRES_HOST: 'db.example.test',
            POSTGRES_PORT: '5432',
            POSTGRES_USER: 'wo',
            PUBLIC_IPV4: '203.0.113.10',
            TURN_NETWORK_MODE: 'bridge',
            TURN_REALM: 'turn.example.test',
            TURN_RELAY_MAX_PORT: '49200',
            TURN_RELAY_MIN_PORT: '49160',
          },
          execute: harness.execute,
          expectedIngressImageId: ingressImageId,
          expectedManifestSha256: 'd'.repeat(64),
          expectedPostgresMajor: 17,
          expectedPostgresSystemIdentifier: postgresSystemIdentifier,
          ingressContainerId,
          manifestFile: fixture.options.manifestFile,
          postgresAdmin: 'release_admin',
          postgresContainerId: 'a'.repeat(64),
          profile: releaseProfile('external-db'),
          provenance,
          resolvedEnvFile: fixture.envFile,
        },
        {
          acquireImageLeases: (captured) => captured,
          captureImages: () => ({
            coturn: {
              composeConfigHash: '8'.repeat(64),
              containerId: 'old-coturn',
              imageId: imageId('2'),
              imageReference: 'wo-coturn:old',
            },
            server: {
              composeConfigHash: serverComposeConfigHash,
              containerId: 'old-server',
              imageId: imageId('1'),
              imageReference: 'wo-server:old',
            },
          }),
          createWorkspace: async () => ({
            directory: workspace,
            override: resolve(workspace, 'rollback.compose.yaml'),
          }),
          loadReleaseBundle: async () => ({ images }),
          releaseResources: async (_directory, _images, selectedRetain) => {
            retain = selectedRetain;
            return false;
          },
          runDatabaseUpgrade: async () => {
            throw primary;
          },
        },
      ),
    ).rejects.toBe(primary);

    expect(retain).toBe(true);
    await expect(stat(workspace)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
  });

  test('rejects a concurrent apply lock before reading the bundle or invoking Docker', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);
    await mkdir(resolve(fixture.rollbackRoot, '.wo-release-apply.lock'), {
      mode: 0o700,
    });
    let bundleRead = false;

    await expect(
      applyRelease(fixture.options, {
        ...fixture.dependencies,
        readReleaseBundle: async () => {
          bundleRead = true;
          return { manifest: { provenance } };
        },
      }),
    ).rejects.toThrow(/release apply lock already exists/i);

    expect(bundleRead).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  test('preserves undefined when apply lock cleanup alone fails', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);
    let rejectionObserved = false;
    let rejection: unknown = Symbol('apply resolved');

    try {
      await applyRelease(fixture.options, {
        ...fixture.dependencies,
        removeDirectory: async (directory: string) => {
          if (directory.endsWith('.wo-release-apply.lock')) {
            throw undefined;
          }
          await rm(directory, { force: true, recursive: true });
        },
      });
    } catch (error) {
      rejectionObserved = true;
      rejection = error;
    }

    expect(rejectionObserved).toBe(true);
    expect(rejection).toBeUndefined();
    await expect(
      stat(resolve(fixture.rollbackRoot, '.wo-release-apply.lock')),
    ).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  test('preserves an undefined apply rejection after successful lock cleanup', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);
    let rejected = false;
    let failure: unknown = Symbol('not rejected');

    try {
      await applyRelease(fixture.options, {
        ...fixture.dependencies,
        readReleaseBundle: async () => {
          throw undefined;
        },
      });
    } catch (error) {
      rejected = true;
      failure = error;
    }

    expect(rejected).toBe(true);
    expect(failure).toBeUndefined();
    await expect(
      stat(resolve(fixture.rollbackRoot, '.wo-release-apply.lock')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('keeps an undefined apply rejection primary when lock cleanup also fails', async () => {
    const harness = createHarness();
    const fixture = await createFixture('external-db', harness.execute);
    const cleanupFailure = new Error('lock cleanup failed');
    let failure: unknown;

    try {
      await applyRelease(fixture.options, {
        ...fixture.dependencies,
        readReleaseBundle: async () => {
          throw undefined;
        },
        removeDirectory: async (directory: string) => {
          if (directory.endsWith('.wo-release-apply.lock')) {
            throw cleanupFailure;
          }
          await rm(directory, { force: true, recursive: true });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toEqual([undefined, cleanupFailure]);
    expect(Object.hasOwn(aggregate, 'cause')).toBe(true);
    expect(aggregate.cause).toBeUndefined();
  });
});
