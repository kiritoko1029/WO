import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const deploy = resolve(root, 'deploy');

const contractEnvironment = Object.freeze({
  ...process.env,
  APP_DOMAIN: 'rtc.example.test',
  ACME_EMAIL: 'operator@example.test',
  POSTGRES_DB: 'wo',
  POSTGRES_USER: 'wo',
  PUBLIC_IPV4: '203.0.113.10',
  TURN_HOST: 'turn.example.test',
  TURN_REALM: 'turn.example.test',
  TURN_PORT: '3478',
  TURN_TLS_PORT: '5349',
  TURN_RELAY_MIN_PORT: '49160',
  TURN_RELAY_MAX_PORT: '49200',
  TURN_URLS:
    'stun:turn.example.test:3478,turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp,turns:turn.example.test:5349?transport=tcp',
  DEPLOY_SECRET_DIR: './secrets',
});

type ComposePort = Readonly<{
  host_ip?: string;
  protocol?: string;
  published?: string | number;
  target?: string | number;
  published_start?: number;
  published_end?: number;
  target_start?: number;
  target_end?: number;
}>;

type ComposeService = Readonly<{
  build?: unknown;
  command?: unknown;
  depends_on?: Record<string, { condition?: string }>;
  entrypoint?: unknown;
  environment?: Record<string, string>;
  healthcheck?: unknown;
  image?: string;
  networks?: Record<string, unknown> | string[];
  ports?: ComposePort[];
  restart?: string;
  secrets?: Array<string | { source: string }>;
  tmpfs?: string[];
  user?: string;
  volumes?: Array<string | { source?: string; target?: string }>;
}>;

type ComposeConfiguration = Readonly<{
  name?: string;
  networks: Record<string, { internal?: boolean; name?: string }>;
  secrets?: Record<string, { file?: string }>;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string }>;
}>;

function renderCompose(
  integration = false,
  environment: NodeJS.ProcessEnv = {},
): ComposeConfiguration {
  const arguments_ = [
    'compose',
    '--project-name',
    integration ? 'wo-integration' : 'wo',
    '-f',
    resolve(deploy, 'compose.yaml'),
  ];
  if (integration) {
    arguments_.push('-f', resolve(deploy, 'compose.integration.yaml'));
  }
  arguments_.push('config', '--format', 'json');
  const result = spawnSync('docker', arguments_, {
    cwd: deploy,
    encoding: 'utf8',
    env: { ...contractEnvironment, ...environment },
  });
  if (result.status !== 0) {
    throw new Error(`docker compose config failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as ComposeConfiguration;
}

function serviceNetworks(service: ComposeService): string[] {
  if (Array.isArray(service.networks)) {
    return service.networks;
  }
  return Object.keys(service.networks ?? {});
}

function serviceSecrets(service: ComposeService): string[] {
  return (service.secrets ?? []).map((secret) =>
    typeof secret === 'string' ? secret : secret.source,
  );
}

function publishedPortStarts(port: ComposePort): number {
  return Number(port.published_start ?? port.published);
}

function publishedPortEnds(port: ComposePort): number {
  return Number(port.published_end ?? port.published);
}

function targetPortStarts(port: ComposePort): number {
  return Number(port.target_start ?? port.target);
}

function targetPortEnds(port: ComposePort): number {
  return Number(port.target_end ?? port.target);
}

function portKey(port: ComposePort): string {
  return `${publishedPortStarts(port)}-${publishedPortEnds(port)}:${targetPortStarts(port)}-${targetPortEnds(port)}/${port.protocol ?? 'tcp'}`;
}

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('production Compose contract', () => {
  test('runs exactly the four self-hosted long-lived services', () => {
    const configuration = renderCompose();
    expect(Object.keys(configuration.services).sort()).toEqual([
      'caddy',
      'coturn',
      'postgres',
      'server',
    ]);
    expect(JSON.stringify(configuration).toLowerCase()).not.toMatch(
      /mediasoup|minio|redis|rustfs|recorder|google\.com|stun\.l\.google/,
    );
  });

  test('publishes only HTTPS edge and direct TURN ports', () => {
    const { services } = renderCompose();
    expect((services.server?.ports ?? []).length).toBe(0);
    expect((services.postgres?.ports ?? []).length).toBe(0);
    expect((services.caddy?.ports ?? []).map(portKey).sort()).toEqual([
      '443-443:443-443/tcp',
      '80-80:80-80/tcp',
    ]);
    const relayPorts = Array.from({ length: 41 }, (_, index) => {
      const port = 49_160 + index;
      return `${port}-${port}:${port}-${port}/udp`;
    });
    expect((services.coturn?.ports ?? []).map(portKey).sort()).toEqual(
      [
        '3478-3478:3478-3478/tcp',
        '3478-3478:3478-3478/udp',
        ...relayPorts,
        '5349-5349:5349-5349/tcp',
        '5349-5349:5349-5349/udp',
      ].sort(),
    );
  });

  test('configures a separate trusted TURN TLS listener and client URL', () => {
    const { services } = renderCompose();
    expect(services.server?.environment?.TURN_URLS?.split(',')).toContain(
      'turns:turn.example.test:5349?transport=tcp',
    );
    expect(serviceSecrets(services.coturn!)).toEqual(
      expect.arrayContaining(['turn_tls_cert', 'turn_tls_key']),
    );
    expect(serviceSecrets(services.caddy!)).not.toEqual(
      expect.arrayContaining(['turn_tls_cert', 'turn_tls_key']),
    );
    const entrypoint = read('deploy/coturn/entrypoint.sh');
    expect(entrypoint).toContain('tls-listening-port=$TURN_TLS_LISTEN_PORT');
    expect(entrypoint).toContain('cert=$runtime_tls_cert');
    expect(entrypoint).toContain('pkey=$runtime_tls_key');
  });

  test('keeps container listeners fixed when host TURN ports are customized', () => {
    const { services } = renderCompose(false, {
      TURN_PORT: '13478',
      TURN_TLS_PORT: '15349',
      TURN_URLS:
        'stun:turn.example.test:13478,turn:turn.example.test:13478?transport=udp,turn:turn.example.test:13478?transport=tcp,turns:turn.example.test:15349?transport=tcp',
    });
    expect(services.coturn?.environment?.TURN_LISTEN_PORT).toBe('3478');
    expect(services.coturn?.environment?.TURN_TLS_LISTEN_PORT).toBe('5349');
    expect((services.coturn?.ports ?? []).map(portKey)).toEqual(
      expect.arrayContaining([
        '13478-13478:3478-3478/tcp',
        '13478-13478:3478-3478/udp',
        '15349-15349:5349-5349/tcp',
        '15349-15349:5349-5349/udp',
      ]),
    );
  });

  test('uses an authenticated TURN allocation for container health', () => {
    const healthcheck = JSON.stringify(
      renderCompose().services.coturn?.healthcheck,
    );
    expect(healthcheck).toContain('/usr/local/bin/turn-healthcheck');
    expect(healthcheck).toContain('/run/secrets/turn_shared_secret');
    expect(healthcheck).not.toContain('cat /run/secrets');
    expect(healthcheck).not.toContain(' -W ');
    expect(healthcheck).not.toContain('turnutils_stunclient');
    const probe = read('deploy/coturn/health-probe.c');
    expect(probe).toContain('HMAC(EVP_sha1()');
    expect(probe).toContain('execv("/usr/bin/turnutils_uclient"');
  });

  test('isolates PostgreSQL and TURN from unrelated services', () => {
    const configuration = renderCompose();
    expect(configuration.networks.api_internal?.internal).toBe(true);
    expect(configuration.networks.db_internal?.internal).toBe(true);
    expect(serviceNetworks(configuration.services.caddy!)).toEqual(
      expect.arrayContaining(['edge', 'api_internal']),
    );
    expect(serviceNetworks(configuration.services.server!).sort()).toEqual([
      'api_internal',
      'db_internal',
    ]);
    expect(serviceNetworks(configuration.services.postgres!)).toEqual([
      'db_internal',
    ]);
    expect(serviceNetworks(configuration.services.coturn!)).toEqual([
      'turn_edge',
    ]);
  });

  test('uses health gates, restart policies, and reviewed patch image tags', () => {
    const { services } = renderCompose();
    for (const service of Object.values(services)) {
      expect(service.restart).toBe('unless-stopped');
      expect(service.healthcheck).toBeDefined();
      if (service.image !== undefined) {
        expect(service.image).toMatch(
          /:[0-9]+\.[0-9]+(?:\.[0-9]+)*(?:[-.][A-Za-z0-9.]+)*$/,
        );
        expect(service.image).not.toMatch(/:latest$/);
      }
    }
    expect(services.server?.depends_on?.postgres?.condition).toBe(
      'service_healthy',
    );
    expect(services.caddy?.depends_on?.server?.condition).toBe(
      'service_healthy',
    );
    expect(services.server?.build).toBeDefined();
  });

  test('mounts least-privilege secrets without putting values in argv or inspect environment', () => {
    const configuration = renderCompose();
    expect(serviceSecrets(configuration.services.postgres!)).toEqual([
      'postgres_password',
    ]);
    expect(serviceSecrets(configuration.services.server!).sort()).toEqual([
      'jwt_access_secret',
      'postgres_password',
      'turn_shared_secret',
    ]);
    expect(serviceSecrets(configuration.services.coturn!).sort()).toEqual([
      'turn_shared_secret',
      'turn_tls_cert',
      'turn_tls_key',
    ]);
    expect(serviceSecrets(configuration.services.caddy!)).toEqual([]);

    for (const service of Object.values(configuration.services)) {
      const inspectVisible = JSON.stringify({
        command: service.command,
        entrypoint: service.entrypoint,
        environment: service.environment,
      });
      expect(inspectVisible).not.toMatch(
        /contract-secret|JWT_ACCESS_SECRET|TURN_SHARED_SECRET|POSTGRES_PASSWORD=/,
      );
    }
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      '/run/secrets/turn_shared_secret',
    );
    expect(read('deploy/coturn/entrypoint.sh')).toContain('chmod 600');
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      'pidfile=/run/wo-turn/turnserver.pid',
    );
    expect(read('deploy/coturn/entrypoint.sh')).not.toMatch(/set\s+-x/);
    expect(configuration.services.coturn?.tmpfs).toContain(
      '/run/wo-turn:uid=65534,gid=65533,mode=0700',
    );
    expect(configuration.services.coturn?.user).toBe('0:0');
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      'chown 65534:65533 "$runtime_config" "$runtime_tls_cert" "$runtime_tls_key"',
    );
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      'nobody:x:65534:65533:',
    );
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      'chmod 600 "$runtime_config" "$runtime_tls_key"',
    );
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      "exec su -s /bin/sh nobody -c 'exec turnserver -c /run/wo-turn/turnserver.conf'",
    );
    expect(configuration.services.server?.user).toBe('0:0');
    const serverEntrypoint = read('deploy/server/entrypoint.sh');
    for (const privilegeBoundary of [
      '/usr/bin/setpriv',
      '--reuid=1000',
      '--regid=1000',
      '--clear-groups',
      '--no-new-privs',
      '--bounding-set=-all',
    ]) {
      expect(serverEntrypoint).toContain(privilegeBoundary);
    }
  });

  test('blocks local and special-use TURN peer destinations', () => {
    const turnConfig = read('deploy/coturn/turnserver.conf');
    for (const range of [
      '0.0.0.0-0.255.255.255',
      '10.0.0.0-10.255.255.255',
      '100.64.0.0-100.127.255.255',
      '127.0.0.0-127.255.255.255',
      '169.254.0.0-169.254.255.255',
      '172.16.0.0-172.31.255.255',
      '192.168.0.0-192.168.255.255',
      '198.18.0.0-198.19.255.255',
      '192.0.2.0-192.0.2.255',
      '198.51.100.0-198.51.100.255',
      '203.0.113.0-203.0.113.255',
      '224.0.0.0-255.255.255.255',
      '::-::1',
      '2001:db8::-2001:db8:ffff:ffff:ffff:ffff:ffff:ffff',
      'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    ]) {
      expect(turnConfig).toContain(`denied-peer-ip=${range}`);
    }
    expect(turnConfig).toContain('no-multicast-peers');
    expect(turnConfig).not.toContain('allowed-peer-ip=8.8.8.8');
    for (const config of [
      turnConfig,
      read('deploy/coturn/turnserver.integration.conf'),
    ]) {
      expect(config).not.toMatch(
        /^(?:no-loopback-peers|no-cli|no-tlsv1|no-tlsv1_1)$/mu,
      );
    }
  });

  test('never mounts relaxed integration TURN policy in production', () => {
    expect(JSON.stringify(renderCompose())).not.toContain(
      'turnserver.integration.conf',
    );
  });
});

describe('local integration Compose contract', () => {
  test('uses a project, networks, volumes, and secret files disjoint from production', () => {
    const production = renderCompose();
    const integration = renderCompose(true);
    expect(production.name).toBe('wo');
    expect(integration.name).toBe('wo-integration');

    const identitySet = (configuration: ComposeConfiguration) =>
      new Set([
        ...Object.keys(configuration.services).map(
          (service) => `${configuration.name}-${service}-1`,
        ),
        ...Object.values(configuration.networks).map(({ name }) => name),
        ...Object.values(configuration.volumes ?? {}).map(({ name }) => name),
      ]);
    const productionIdentities = identitySet(production);
    const integrationIdentities = identitySet(integration);
    expect(
      [...productionIdentities].filter((identity) =>
        integrationIdentities.has(identity),
      ),
    ).toEqual([]);

    const secretFiles = (configuration: ComposeConfiguration) =>
      Object.values(configuration.secrets ?? {}).map(({ file }) => file);
    const normalizedSecretFiles = (configuration: ComposeConfiguration) =>
      secretFiles(configuration).map((file) => file?.replaceAll('\\', '/'));
    expect(normalizedSecretFiles(production).join('\n')).toContain(
      'deploy/secrets/',
    );
    expect(normalizedSecretFiles(integration).join('\n')).toContain(
      'deploy/secrets.integration/',
    );
    expect(
      secretFiles(production).filter((file) =>
        secretFiles(integration).includes(file),
      ),
    ).toEqual([]);
  });

  test('replaces every public binding with a loopback-only binding', () => {
    const configuration = renderCompose(true);
    const publishedPorts = Object.values(configuration.services).flatMap(
      (service) => service.ports ?? [],
    );
    expect(publishedPorts.length).toBeGreaterThan(0);
    for (const port of publishedPorts) {
      expect(['127.0.0.1', '::1']).toContain(port.host_ip);
    }
  });

  test('uses a separate local CA and relaxed TURN config without exporting CA keys', () => {
    const configuration = renderCompose(true);
    expect(JSON.stringify(configuration.services.caddy?.volumes)).toContain(
      'Caddyfile.integration',
    );
    expect(read('deploy/caddy/Caddyfile.integration')).toContain(
      'tls internal',
    );
    expect(JSON.stringify(configuration.services.coturn?.volumes)).toContain(
      'turnserver.integration.conf',
    );
    expect(read('deploy/coturn/turnserver.integration.conf')).toContain(
      'allow-loopback-peers',
    );
    expect(read('deploy/coturn/turnserver.conf')).not.toContain(
      'allow-loopback-peers',
    );
    expect(JSON.stringify(configuration)).not.toMatch(
      /pki\/authorities\/local|pki\\authorities\\local/,
    );
    expect(
      configuration.services.server?.environment?.TURN_URLS?.split(','),
    ).toContain('turns:turn.localhost:5349?transport=tcp');
  });
});
