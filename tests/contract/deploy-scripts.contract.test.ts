import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  firewallSummary,
  isPublicIpv4,
  parseDotEnv,
  semverAtLeast,
  validateTurnTlsIdentity,
  validateDeploymentEnvironment,
  validateGeneratedSecret,
} from '../../deploy/scripts/lib.mjs';

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
      'UDP 3478,5349,49160-49200',
    ]);
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
    expect(example).toContain('DEPLOY_SECRET_DIR=./secrets');
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
    expect(operations).toContain("productionProject = 'wo'");
    expect(operations).toContain("integrationProject = 'wo-integration'");
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
    const pullIndex = upgrade.indexOf("'pull'");
    const quiesceIndex = upgrade.indexOf("'stop', 'caddy', 'server'");
    const backupIndex = upgrade.lastIndexOf('runBackup()');
    expect(pullIndex).toBeGreaterThan(-1);
    expect(quiesceIndex).toBeGreaterThan(pullIndex);
    expect(backupIndex).toBeGreaterThan(quiesceIndex);
    const internalSmokeIndex = upgrade.lastIndexOf('runInternalSmoke(envFile)');
    const caddyActivationIndex = upgrade.indexOf(
      "composeArguments(envFile, 'up', '-d', '--wait', 'caddy')",
    );
    expect(internalSmokeIndex).toBeGreaterThan(backupIndex);
    expect(caddyActivationIndex).toBeGreaterThan(internalSmokeIndex);
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

  test('integration smoke proves authenticated TURN data, TLS, and credential rejection', () => {
    const smoke = read('smoke.mjs');
    expect(smoke).toContain('turnutils_uclient');
    expect(smoke).toContain('tls.connect');
    expect(smoke).toContain('TURN rejected invalid credentials');
    expect(smoke).toContain('TURN relay data passed');
    expect(smoke).toContain("runTurnClient(envFile, credentials, 'tcp', true)");
    expect(smoke).toContain('Smoke: authenticated TURN TCP relay data passed');
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
      'restore.mjs',
      'upgrade.mjs',
      '49160-49200/UDP',
      'external host',
      'RustFS',
    ]) {
      expect(guide).toContain(marker);
    }
    expect(guide).not.toMatch(
      /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|ignore-certificate-errors/,
    );
  });
});
