import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  firewallSummary,
  isPrivateIpv4,
  isPublicIpv4,
  parseDotEnv,
  semverAtLeast,
  turnNetworkMode,
  turnRelayPortLimit,
  validateTurnTlsIdentity,
  validateDeploymentEnvironment,
  validateGeneratedSecret,
} from '../../deploy/scripts/lib.mjs';
import {
  deploymentProcessEnvironment,
  productionComposeFiles,
} from '../../deploy/scripts/ops.mjs';
import {
  assertProductionComposeCommand,
  classifyComposeCommand,
  composeCommandNeedsReleaseProvenance,
  composeCommandRequiresReleaseBundle,
} from '../../deploy/scripts/compose.mjs';
import {
  integrationReleaseProvenance,
  releaseProvenanceEnvironment,
  releaseProvenanceFromGitMetadata,
  validateReleaseProvenance,
} from '../../deploy/scripts/provenance.mjs';

const root = resolve(import.meta.dirname, '..', '..');

const validEnvironment = Object.freeze({
  APP_DOMAIN: 'rtc.example.com',
  ACME_EMAIL: 'operator@example.com',
  POSTGRES_DB: 'wo',
  POSTGRES_USER: 'wo',
  PUBLIC_IPV4: '203.0.114.10',
  TURN_HOST: 'turn.example.com',
  TURN_REALM: 'turn.example.com',
  TURN_PORT: '3478',
  TURN_TLS_PORT: '5349',
  TURN_RELAY_MIN_PORT: '49160',
  TURN_RELAY_MAX_PORT: '49200',
  TURN_URLS:
    'stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp',
  BACKUP_DIR: './backups',
  DEPLOY_SECRET_DIR: './secrets',
});

describe('deployment preflight validation', () => {
  test('parses comments and quoted values while rejecting duplicates', () => {
    expect(
      parseDotEnv(
        `\n# deployment\nAPP_DOMAIN=rtc.example.com\nACME_EMAIL="ops@example.com"\n`,
      ),
    ).toEqual({
      APP_DOMAIN: 'rtc.example.com',
      ACME_EMAIL: 'ops@example.com',
    });
    expect(() => parseDotEnv('APP_DOMAIN=a\nAPP_DOMAIN=b\n')).toThrow(
      /duplicate/i,
    );
  });

  test('accepts only public unicast IPv4 addresses', () => {
    expect(isPublicIpv4('8.8.8.8')).toBe(true);
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.2.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      'not-an-ip',
    ]) {
      expect(isPublicIpv4(address), address).toBe(false);
    }
  });

  test('accepts only RFC1918 addresses for TURN host networking', () => {
    for (const address of ['10.0.0.1', '172.24.52.219', '192.168.1.1']) {
      expect(isPrivateIpv4(address), address).toBe(true);
    }
    for (const address of [
      '8.8.8.8',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      'not-an-ip',
    ]) {
      expect(isPrivateIpv4(address), address).toBe(false);
    }
  });

  test('rejects unsafe production intent and accepts a bounded relay range', () => {
    expect(
      validateDeploymentEnvironment(validEnvironment, { platform: 'linux' }),
    ).toEqual([]);

    const issues = validateDeploymentEnvironment(
      {
        ...validEnvironment,
        APP_DOMAIN: 'localhost',
        PUBLIC_IPV4: '192.168.1.2',
        POSTGRES_USER: 'wo-admin;',
        TURN_RELAY_MIN_PORT: '50000',
        TURN_RELAY_MAX_PORT: '49999',
      },
      { platform: 'win32' },
    );
    expect(issues.join('\n')).toMatch(/Linux/);
    expect(issues.join('\n')).toMatch(/APP_DOMAIN/);
    expect(issues.join('\n')).toMatch(/PUBLIC_IPV4/);
    expect(issues.join('\n')).toMatch(/POSTGRES_USER/);
    expect(issues.join('\n')).toMatch(/relay/i);
  });

  test('allows explicit loopback intent only for the local integration profile', () => {
    const local = {
      ...validEnvironment,
      APP_DOMAIN: 'rtc.localhost',
      ACME_EMAIL: 'integration@localhost.invalid',
      PUBLIC_IPV4: '127.0.0.1',
      TURN_HOST: 'turn.localhost',
      TURN_REALM: 'turn.localhost',
      TURN_URLS:
        'stun:turn.localhost:3478,turn:turn.localhost:3478?transport=udp,turn:turn.localhost:3478?transport=tcp',
    };
    expect(
      validateDeploymentEnvironment(local, {
        platform: 'win32',
        integration: true,
      }),
    ).toEqual([]);
    expect(
      validateDeploymentEnvironment(local, { platform: 'linux' }).join('\n'),
    ).toMatch(/public/i);
  });

  test('keeps bridge bounded while allowing an explicit bounded host profile', () => {
    const bridgeTooWide = {
      ...validEnvironment,
      TURN_RELAY_MIN_PORT: '49160',
      TURN_RELAY_MAX_PORT: '49360',
    };
    expect(
      validateDeploymentEnvironment(bridgeTooWide, {
        platform: 'linux',
      }).join('\n'),
    ).toMatch(/at most 200/i);

    const host = {
      ...validEnvironment,
      TURN_NETWORK_MODE: 'host',
      TURN_INTERNAL_IP: '172.24.52.219',
      TURN_STATE_EMPTY_DIR: '/var/empty/wo-turn',
      TURN_RELAY_MIN_PORT: '49160',
      TURN_RELAY_MAX_PORT: '49509',
    };
    expect(validateDeploymentEnvironment(host, { platform: 'linux' })).toEqual(
      [],
    );
    expect(turnNetworkMode(host)).toBe('host');
    expect(turnRelayPortLimit(host)).toBe(512);
    expect(
      validateDeploymentEnvironment(
        { ...host, TURN_RELAY_MAX_PORT: '49672' },
        { platform: 'linux' },
      ).join('\n'),
    ).toMatch(/at most 512/i);

    for (const invalidHost of [
      { ...host, TURN_INTERNAL_IP: '' },
      { ...host, TURN_INTERNAL_IP: '8.8.8.8' },
      { ...host, TURN_STATE_EMPTY_DIR: 'relative/path' },
      { ...host, TURN_NETWORK_MODE: 'invalid' },
    ]) {
      expect(
        validateDeploymentEnvironment(invalidHost, {
          platform: 'linux',
        }).length,
      ).toBeGreaterThan(0);
    }
    expect(
      validateDeploymentEnvironment(
        { ...validEnvironment, TURN_INTERNAL_IP: '172.24.52.219' },
        { platform: 'linux' },
      ).join('\n'),
    ).toMatch(/only allowed in host mode/i);
  });

  test('requires TURN URLs to use their configured public listener ports', () => {
    const issues = validateDeploymentEnvironment(
      {
        ...validEnvironment,
        TURN_PORT: '13478',
        TURN_TLS_PORT: '15349',
        TURN_URLS:
          'stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp',
      },
      { platform: 'linux' },
    );
    expect(issues.join('\n')).toMatch(/TURN_PORT/);
    expect(issues.join('\n')).toMatch(/TURN_TLS_PORT/);
  });

  test('rejects invalid TURN URL transport and overlapping listeners', () => {
    const issues = validateDeploymentEnvironment(
      {
        ...validEnvironment,
        TURN_TLS_PORT: '3478',
        TURN_URLS:
          'stun:turn.example.com:3478?transport=tcp,turn:turn.example.com:3478?transport=udp,turns:turn.example.com:3478?transport=udp',
      },
      { platform: 'linux' },
    ).join('\n');
    expect(issues).toMatch(/transport/i);
    expect(issues).toMatch(/unique|overlap|conflict/i);
  });

  test('requires canonical 32-byte base64url generated secrets', () => {
    const generated = Buffer.alloc(32);
    for (let index = 0; index < generated.length; index += 1) {
      generated[index] = index;
    }
    expect(validateGeneratedSecret(generated.toString('base64url'))).toBeNull();
    expect(validateGeneratedSecret('change-me')).toMatch(/base64url/i);
    expect(
      validateGeneratedSecret(Buffer.alloc(16, 7).toString('base64url')),
    ).toMatch(/32/);
  });

  test('compares Compose versions and prints exact firewall openings', () => {
    expect(semverAtLeast('2.24.4', '2.24.4')).toBe(true);
    expect(semverAtLeast('5.1.0', '2.24.4')).toBe(true);
    expect(semverAtLeast('2.24.3', '2.24.4')).toBe(false);
    expect(firewallSummary(validEnvironment)).toEqual([
      'TCP 80,443,3478,5349',
      'UDP 3478,49160-49200',
    ]);
    expect(
      productionComposeFiles(validEnvironment).map((file) =>
        file.replaceAll('\\', '/'),
      ),
    ).toEqual([expect.stringMatching(/\/deploy\/compose\.yaml$/u)]);
    expect(
      productionComposeFiles({
        ...validEnvironment,
        TURN_NETWORK_MODE: 'host',
      })
        .map((file) => file.replaceAll('\\', '/'))
        .at(-1),
    ).toMatch(/\/deploy\/compose\.turn-host\.yaml$/u);
  });

  test('passes only controlled Docker and integration fields to Compose', () => {
    const childEnvironment = deploymentProcessEnvironment(
      {
        DEPLOY_SECRET_DIR: './secrets',
        BUILD_CREATED: 'forged-env-file-created',
        BUILD_REVISION: 'forged-env-file-revision',
        BUILD_VERSION: 'forged-env-file-version',
        DOCKER_HOST: 'tcp://untrusted-env-file.invalid:2376',
        LD_PRELOAD: '/tmp/untrusted.so',
        NODE_OPTIONS: '--require=/tmp/untrusted.js',
        PATH: '/untrusted/env-file/bin',
        SMTP_PASS: 'env-file-secret',
        TURN_PORT: '3478',
        TURN_RELAY_MAX_PORT: '49200',
        TURN_RELAY_MIN_PORT: '49160',
        WO_INTEGRATION_HTTP_PORT: '18080',
      },
      {
        DEPLOY_SECRET_DIR: '/tmp/unvalidated-secrets',
        BUILD_CREATED: 'forged-shell-created',
        BUILD_REVISION: 'forged-shell-revision',
        BUILD_VERSION: 'forged-shell-version',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        PATH: '/usr/bin',
        SMTP_PASS: 'shell-injected',
        TURN_PORT: '19999',
        TURN_RELAY_MAX_PORT: '65535',
        TURN_RELAY_MIN_PORT: '1',
        UNRELATED_SHELL_VALUE: 'must-not-leak',
        WO_INTEGRATION_HTTP_PORT: '19080',
      },
    );
    expect(childEnvironment).toEqual(
      expect.objectContaining({
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        PATH: '/usr/bin',
        WO_INTEGRATION_HTTP_PORT: '19080',
      }),
    );
    expect(childEnvironment).not.toHaveProperty('DEPLOY_SECRET_DIR');
    expect(childEnvironment).not.toHaveProperty('TURN_PORT');
    expect(childEnvironment).not.toHaveProperty('TURN_RELAY_MAX_PORT');
    expect(childEnvironment).not.toHaveProperty('TURN_RELAY_MIN_PORT');
    expect(childEnvironment).not.toHaveProperty('SMTP_PASS');
    expect(childEnvironment).not.toHaveProperty('LD_PRELOAD');
    expect(childEnvironment).not.toHaveProperty('NODE_OPTIONS');
    expect(childEnvironment).not.toHaveProperty('UNRELATED_SHELL_VALUE');
    expect(childEnvironment).not.toHaveProperty('BUILD_CREATED');
    expect(childEnvironment).not.toHaveProperty('BUILD_REVISION');
    expect(childEnvironment).not.toHaveProperty('BUILD_VERSION');
  });

  test('accepts only deterministic clean-Git or fixed integration provenance', () => {
    const production = releaseProvenanceFromGitMetadata({
      commitEpoch: '1784917907',
      revision: 'b88a10f0867cfe349689269407145e8c7ff6afe5',
      status: '',
    });
    expect(production).toEqual({
      BUILD_CREATED: '2026-07-24T18:31:47Z',
      BUILD_REVISION: 'b88a10f0867cfe349689269407145e8c7ff6afe5',
      BUILD_VERSION: '2026.07.24-b88a10f0867c',
      SOURCE_DATE_EPOCH: '1784917907',
    });
    expect(releaseProvenanceEnvironment(production)).toEqual(production);
    expect(() =>
      releaseProvenanceFromGitMetadata({
        commitEpoch: '1784917907',
        revision: production.BUILD_REVISION,
        status: ' M deploy/compose.yaml',
      }),
    ).toThrow(/clean Git worktree/i);
    expect(
      validateReleaseProvenance(
        {
          ...integrationReleaseProvenance,
          BUILD_REVISION: production.BUILD_REVISION,
        },
        { production: false },
      ),
    ).toContain(
      'BUILD_REVISION must use the fixed integration release sentinel',
    );
    expect(
      validateReleaseProvenance({ ...production, BUILD_VERSION: 5 }).join('\n'),
    ).toMatch(/BUILD_VERSION is required/i);
    expect(
      validateReleaseProvenance({ ...production, BUILD_VERSION: null }).join(
        '\n',
      ),
    ).toMatch(/BUILD_VERSION is required/i);
  });

  test('routes production image selection through the release bundle gate', () => {
    expect(composeCommandNeedsReleaseProvenance(['config', '--quiet'])).toBe(
      true,
    );
    for (const command of [
      'build',
      'commit',
      'create',
      'publish',
      'pull',
      'push',
      'run',
      'scale',
      'up',
      'watch',
    ]) {
      expect(
        composeCommandRequiresReleaseBundle([command, 'server']),
        command,
      ).toBe(true);
      expect(
        composeCommandNeedsReleaseProvenance([command, 'server']),
        command,
      ).toBe(true);
    }
    expect(composeCommandRequiresReleaseBundle(['ps'])).toBe(false);
    expect(composeCommandRequiresReleaseBundle(['down'])).toBe(false);
    expect(assertProductionComposeCommand(['up', '-d'], undefined)).toBe(
      'release-bundle',
    );
    expect(assertProductionComposeCommand(['build'], undefined)).toBe(
      'release-bundle',
    );
    for (const command of ['commit', 'publish', 'pull', 'push', 'scale']) {
      expect(
        () => assertProductionComposeCommand([command], undefined),
        command,
      ).toThrow(/build-release\.mjs and apply-release\.mjs/i);
    }
    expect(() =>
      assertProductionComposeCommand(['up', '-d'], 'docker-compose.yml'),
    ).toThrow(/build-release\.mjs and apply-release\.mjs/i);
    expect(assertProductionComposeCommand(['ps'], 'docker-compose.yml')).toBe(
      'operational',
    );
    expect(() => classifyComposeCommand(['--profile', 'unsafe', 'up'])).toThrow(
      /first argument/i,
    );
    expect(() => classifyComposeCommand(['unknown'])).toThrow(/unsupported/i);
  });

  test('validates TURN certificate identity, lifetime, key match, and trust intent', () => {
    const certificatePem = readFileSync(
      resolve(root, 'tests', 'fixtures', 'deploy-turn-cert.pem'),
      'utf8',
    );
    const privateKeyPem = readFileSync(
      resolve(root, 'tests', 'fixtures', 'deploy-turn-key.pem'),
      'utf8',
    );
    const certificate = new X509Certificate(certificatePem);
    const validNow =
      Date.parse(certificate.validFrom) + 8 * 24 * 60 * 60 * 1_000;
    expect(
      validateTurnTlsIdentity({
        certificatePem,
        privateKeyPem,
        hostname: 'turn.example.com',
        now: validNow,
        production: false,
      }),
    ).toEqual([]);

    expect(
      validateTurnTlsIdentity({
        certificatePem,
        privateKeyPem,
        hostname: 'wrong.example.com',
        now: validNow,
        production: false,
      }).join('\n'),
    ).toMatch(/hostname/i);
    expect(
      validateTurnTlsIdentity({
        certificatePem,
        privateKeyPem,
        hostname: 'turn.example.com',
        now: Date.parse(certificate.validTo) - 6 * 24 * 60 * 60 * 1_000,
        production: false,
      }).join('\n'),
    ).toMatch(/7 days/i);
    const mismatchedKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    expect(
      validateTurnTlsIdentity({
        certificatePem,
        privateKeyPem: mismatchedKey,
        hostname: 'turn.example.com',
        now: validNow,
        production: false,
      }).join('\n'),
    ).toMatch(/match/i);
    expect(
      validateTurnTlsIdentity({
        certificatePem,
        privateKeyPem,
        hostname: 'turn.example.com',
        now: validNow,
        production: true,
      }).join('\n'),
    ).toMatch(/self-issued/i);

    const leafCertificatePem = readFileSync(
      resolve(root, 'tests', 'fixtures', 'deploy-turn-leaf-cert.pem'),
      'utf8',
    );
    const leafPrivateKeyPem = readFileSync(
      resolve(root, 'tests', 'fixtures', 'deploy-turn-leaf-key.pem'),
      'utf8',
    );
    const leafCertificate = new X509Certificate(leafCertificatePem);
    const leafNow =
      Date.parse(leafCertificate.validFrom) + 8 * 24 * 60 * 60 * 1_000;
    expect(
      validateTurnTlsIdentity({
        certificatePem: `${leafCertificatePem}\n${certificatePem}`,
        privateKeyPem: leafPrivateKeyPem,
        hostname: 'turn.production.example',
        now: leafNow,
        production: true,
        trustedCertificates: [certificatePem],
      }),
    ).toEqual([]);
    expect(
      validateTurnTlsIdentity({
        certificatePem: leafCertificatePem,
        privateKeyPem: leafPrivateKeyPem,
        hostname: 'turn.production.example',
        now: leafNow,
        production: true,
        trustedCertificates: [],
      }).join('\n'),
    ).toMatch(/trusted/i);
  });
});

describe('operational script contract', () => {
  const read = (name: string): string =>
    readFileSync(resolve(root, 'deploy', 'scripts', name), 'utf8');

  test('preflight checks Docker, DNS, disk, secret files, and occupied ports', () => {
    const script = read('preflight.mjs');
    expect(script).toContain('docker');
    expect(script).toContain('resolve4');
    expect(script).toContain('statfs');
    expect(script).toContain('turn_tls_key.pem');
    expect(script).toContain('checkPortConflicts');
  });

  test('example environment references files and initializer never overwrites secrets', () => {
    const example = readFileSync(
      resolve(root, 'deploy', '.env.example'),
      'utf8',
    );
    expect(example).not.toMatch(
      /^(?:JWT_ACCESS_SECRET|POSTGRES_PASSWORD|TURN_SHARED_SECRET)=/mu,
    );
    expect(example).toContain('DEPLOY_SECRET_DIR=/opt/wo/deploy/secrets');
    expect(example).toContain('DEPLOY_SMOKE_EMAILS=');
    expect(example).toContain('DEPLOY_SMOKE_PASSWORD=');
    expect(example).toContain('turns:');
    const initializer = read('init-secrets.mjs');
    expect(initializer).toContain('randomBytes(32)');
    expect(initializer).toContain("flag: 'wx'");
    expect(initializer).not.toContain('turn_tls_key.pem');
  });

  test('integration uses a separate environment and atomic local certificate initializer', () => {
    const example = readFileSync(
      resolve(root, 'deploy', '.env.integration.example'),
      'utf8',
    );
    expect(example).toContain('DEPLOY_SECRET_DIR=./secrets.integration');
    expect(example).toContain('BACKUP_DIR=./backups.integration');
    const initializer = read('init-integration-cert.mjs');
    expect(initializer).toContain("flag: 'wx'");
    expect(initializer).toContain("'./secrets.integration'");
    expect(initializer).not.toMatch(/force|overwrite/iu);
  });

  test('all Compose callers select an explicit production or integration project', () => {
    const operations = read('ops.mjs');
    const compose = read('compose.mjs');
    expect(operations).toContain("productionProject = 'wo'");
    expect(operations).toContain("integrationProject = 'wo-integration'");
    expect(operations).toContain("'--project-name'");
    expect(operations).toContain("'--env-file'");
    expect(operations).toContain("'.wo-release-apply.lock'");
    expect(compose).toContain('composeArguments');
    expect(compose).toContain('integrationComposeArguments');
    expect(compose).toContain('rootComposeArguments');
    expect(operations).toContain('docker-compose.external-db.yml');
    const integrationTest = readFileSync(
      resolve(
        root,
        'tests',
        'integration',
        'compose-stack.integration.test.ts',
      ),
      'utf8',
    );
    expect(integrationTest).toContain("'--project-name'");
    expect(integrationTest).toContain("'wo-integration'");
  });

  test('local CA export copies only the public root certificate', () => {
    const exporter = read('export-local-ca.mjs');
    expect(exporter).toContain('/data/caddy/pki/authorities/local/root.crt');
    expect(exporter).not.toMatch(/root\.key|intermediate\.key/);
    expect(exporter).toContain('docker');
    expect(exporter).toMatch(/compose/iu);
  });

  test('backup, restore, and upgrade preserve PostgreSQL and Caddy state safely', () => {
    const applyRelease = read('apply-release.mjs');
    const backup = read('backup.mjs');
    const restore = read('restore.mjs');
    const upgrade = read('upgrade.mjs');
    expect(backup).toContain('pg_dump');
    expect(backup).toContain("hasArgument('--integration')");
    expect(backup).toContain("'-C',\n      '/data'");
    expect(backup).toContain("'caddy'");
    expect(restore).toContain('pg_restore');
    expect(restore).toContain("hasArgument('--integration')");
    expect(restore).toContain('--confirm-restore');
    expect(restore).toContain('--exit-on-error');
    expect(restore).toContain('--single-transaction');
    expect(restore).toContain('stagingDatabase');
    expect(restore).toContain('ALTER DATABASE');
    expect(restore).not.toContain("'--create'");
    expect(restore).toContain('inspectCaddyArchive');
    expect(restore).toContain('rollback');
    expect(upgrade).toContain('backup.mjs');
    expect(upgrade).toContain('config');
    expect(upgrade).toContain('--wait');
    expect(upgrade).toContain('assertPostgresMajorUnchanged');
    expect(upgrade).toContain('rollback');
    expect(upgrade).toContain("composeArguments(envFile, 'pull', 'postgres')");
    expect(upgrade).toMatch(
      /composeArguments\(\s*envFile,\s*'build',\s*'--pull',\s*'caddy',\s*'server',\s*'coturn',?\s*\)/u,
    );
    for (const script of [backup, restore, upgrade]) {
      expect(script).toMatch(
        /withDeploymentOperationLock\(\s*deployDirectory,/u,
      );
    }
    expect(applyRelease).toContain('operationLockRoot = deployDirectory');
    expect(applyRelease).toContain(
      'acquireReleaseApplyLock(operationLockRoot)',
    );
    for (const service of ['caddy', 'server', 'postgres', 'coturn']) {
      expect(restore).toContain(`'${service}'`);
    }
    expect(upgrade).toContain('deploymentOperationProcessEnvironment');
    const pullIndex = upgrade.indexOf("'pull'");
    const quiesceIndex = upgrade.indexOf("'stop', 'caddy', 'server'");
    const backupIndex = upgrade.lastIndexOf(
      'runBackup({ operationLockToken })',
    );
    expect(pullIndex).toBeGreaterThan(-1);
    expect(quiesceIndex).toBeGreaterThan(pullIndex);
    expect(backupIndex).toBeGreaterThan(quiesceIndex);
    const provenanceInspectionIndex = upgrade.lastIndexOf(
      'inspectBuiltReleaseImages(envFile, provenance)',
    );
    const internalSmokeIndex = upgrade.lastIndexOf(
      'runInternalSmoke(envFile, provenance, releaseOverride)',
    );
    const caddyActivationIndex = upgrade.lastIndexOf(
      "'Public edge activation'",
    );
    expect(provenanceInspectionIndex).toBeGreaterThan(pullIndex);
    expect(quiesceIndex).toBeGreaterThan(provenanceInspectionIndex);
    expect(internalSmokeIndex).toBeGreaterThan(backupIndex);
    expect(caddyActivationIndex).toBeGreaterThan(internalSmokeIndex);
    expect(upgrade).toContain("'--no-build'");
    expect(upgrade.match(/retainRollbackWorkspace = true/gu)).toHaveLength(3);
    expect(upgrade).toContain('publicExposureAttempted');
    expect(upgrade).toContain('without data rollback');
    for (const script of [backup, restore, upgrade]) {
      expect(script).not.toMatch(/TURN_SHARED_SECRET|JWT_ACCESS_SECRET/);
    }
  });

  test('smoke exercises auth, signaling, two-person capacity, and screen lease cleanup', () => {
    const smoke = read('smoke.mjs');
    for (const marker of [
      '/v1/auth/register',
      '/v1/auth/login',
      '/v1/realtime/ticket',
      'room.create',
      'room.join',
      'ROOM_CODE_INVALID',
      'webrtc.offer',
      'webrtc.answer',
      'webrtc.iceCandidate',
      'screen.acquire',
      'screen.release',
      'room.end',
      '/v1/auth/logout',
    ]) {
      expect(smoke).toContain(marker);
    }
    expect(smoke).not.toMatch(/console\.log\([^\n]*(token|sdp)/i);
  });

  test('integration smoke proves TURN data and explicit credential, DNS, and TLS failures', () => {
    const smoke = read('smoke.mjs');
    expect(smoke).toContain('turnutils_uclient');
    expect(smoke).toContain('tls.connect');
    expect(smoke).toContain('TURN rejected invalid credentials');
    expect(smoke).toContain('TURN rejected expired credentials');
    expect(smoke).toContain('TURN rejected an invalid TLS hostname');
    expect(smoke).toContain('TURN DNS failure was explicit');
    expect(smoke).toContain('TURN relay data passed');
    expect(smoke).toContain("runTurnClient(envFile, credentials, 'tcp', true)");
    expect(smoke).toContain(
      'Smoke: authenticated TURN-over-TCP UDP relay data passed',
    );
    expect(smoke).toContain(
      'turnutils_uclient -u "$username" -w "$credential" -t -c',
    );
    expect(smoke).toContain("'65534:65533'");
    expect(smoke).toContain('/run/wo-turn/wo-turn-peer-$$.log');
    expect(smoke).toContain('kill -0 "$peer_pid"');
    expect(smoke).not.toContain('/tmp/wo-turn-peer');
    const integrationTest = readFileSync(
      resolve(
        root,
        'tests',
        'integration',
        'compose-stack.integration.test.ts',
      ),
      'utf8',
    );
    expect(integrationTest).toContain("'--turn-proof'");
    expect(integrationTest).toContain("'--integration'");
  });

  test('integration smoke keeps active and new WSS through a bounded proxy reload proof', () => {
    const smoke = read('smoke.mjs');
    expect(smoke).toContain('Proxy reload proof is restricted');
    expect(smoke).toContain("'caddy',\n    'reload'");
    expect(smoke).toContain('proxy reload and idle timeout window');
    expect(smoke).toContain('clients[0]?.socket.readyState !== WebSocket.OPEN');
    const integrationTest = readFileSync(
      resolve(
        root,
        'tests',
        'integration',
        'compose-stack.integration.test.ts',
      ),
      'utf8',
    );
    expect(integrationTest).toContain("'--proxy-reload-proof'");
  });

  test('deployment guide documents production, local trust, operations, and honest TURN proof', () => {
    const guide = readFileSync(resolve(root, 'docs', 'deployment.md'), 'utf8');
    for (const marker of [
      'Caddy',
      'PostgreSQL',
      'coturn',
      'init-secrets.mjs',
      'preflight.mjs',
      'docker compose',
      'export-local-ca.mjs',
      'backup.mjs',
      'monitor.mjs',
      'restore.mjs',
      'upgrade.mjs',
      'compose.turn-host.yaml',
      'TURN_NETWORK_MODE=host',
      'ip_local_reserved_ports',
      '5349/TCP',
      '49160-49200/UDP',
      'external host',
      'RustFS',
    ]) {
      expect(guide).toContain(marker);
    }
    expect(guide).not.toMatch(
      /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|ignore-certificate-errors/,
    );
    expect(guide).not.toContain('5349/TCP+UDP');
  });
});
