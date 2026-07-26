import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const deploy = resolve(root, 'deploy');

const contractEnvironment = Object.freeze({
  ...process.env,
  BUILD_CREATED: '2026-07-24T18:31:47Z',
  BUILD_REVISION: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  BUILD_VERSION: '2026.07.24-aaaaaaaaaaaa',
  SOURCE_DATE_EPOCH: '1784917907',
  APP_DOMAIN: 'rtc.example.test',
  ACME_EMAIL: 'operator@example.test',
  POSTGRES_DB: 'wo',
  POSTGRES_USER: 'wo',
  PUBLIC_IPV4: '203.0.113.10',
  TURN_HOST: 'turn.example.test',
  TURN_INTERNAL_IP: '',
  TURN_REALM: 'turn.example.test',
  TURN_PORT: '3478',
  TURN_TLS_PORT: '5349',
  TURN_RELAY_MIN_PORT: '49160',
  TURN_RELAY_MAX_PORT: '49200',
  TURN_URLS:
    'stun:turn.example.test:3478,turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp,turns:turn.example.test:5349?transport=tcp',
  DEPLOY_SECRET_DIR: resolve(deploy, 'secrets'),
  WO_INTEGRATION_HTTP_PORT: '',
  WO_INTEGRATION_HTTPS_PORT: '',
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
  build?: {
    args?: Record<string, string>;
  };
  cap_add?: string[];
  cap_drop?: string[];
  command?: unknown;
  depends_on?: Record<string, { condition?: string }>;
  entrypoint?: unknown;
  environment?: Record<string, string>;
  healthcheck?: unknown;
  image?: string;
  logging?: {
    driver?: string;
    options?: Record<string, string>;
  };
  mem_limit?: number | string;
  network_mode?: string;
  networks?: Record<string, unknown> | string[];
  pids_limit?: number;
  ports?: ComposePort[];
  read_only?: boolean;
  restart?: string;
  secrets?: Array<string | { source: string }>;
  security_opt?: string[];
  tmpfs?: string[];
  user?: string;
  volumes?: Array<
    | string
    | {
        read_only?: boolean;
        source?: string;
        target?: string;
        type?: string;
      }
  >;
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
  const effectiveEnvironment = { ...contractEnvironment, ...environment };
  const arguments_ = [
    'compose',
    '--project-name',
    integration ? 'wo-integration' : 'wo',
    '-f',
    resolve(deploy, 'compose.yaml'),
  ];
  if (integration) {
    arguments_.push('-f', resolve(deploy, 'compose.integration.yaml'));
  } else if (effectiveEnvironment.TURN_NETWORK_MODE === 'host') {
    arguments_.push('-f', resolve(deploy, 'compose.turn-host.yaml'));
  }
  arguments_.push('config', '--format', 'json');
  const result = spawnSync('docker', arguments_, {
    cwd: deploy,
    encoding: 'utf8',
    env: effectiveEnvironment,
  });
  if (result.status !== 0) {
    throw new Error(`docker compose config failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as ComposeConfiguration;
}

function renderRootCompose(
  fileName: string,
  environment: NodeJS.ProcessEnv = {},
): ComposeConfiguration {
  const effectiveEnvironment = {
    ...contractEnvironment,
    POSTGRES_HOST: 'postgres.external.test',
    ...environment,
  };
  const composeFiles = ['-f', resolve(root, fileName)];
  if (effectiveEnvironment.TURN_NETWORK_MODE === 'host') {
    composeFiles.push('-f', resolve(deploy, 'compose.turn-host.yaml'));
  }
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      'wo-root-contract',
      ...composeFiles,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: effectiveEnvironment,
    },
  );
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
  test('renders every root secret from the exact absolute deploy directory', () => {
    const expected = {
      jwt_access_secret: resolve(deploy, 'secrets', 'jwt_access_secret'),
      postgres_password: resolve(deploy, 'secrets', 'postgres_password'),
      turn_shared_secret: resolve(deploy, 'secrets', 'turn_shared_secret'),
      turn_tls_cert: resolve(deploy, 'secrets', 'turn_tls_cert.pem'),
      turn_tls_key: resolve(deploy, 'secrets', 'turn_tls_key.pem'),
    };
    for (const configuration of [
      renderRootCompose('docker-compose.yml'),
      renderRootCompose('docker-compose.external-db.yml'),
    ]) {
      expect(
        Object.fromEntries(
          Object.entries(configuration.secrets ?? {}).map(([name, secret]) => [
            name,
            secret.file,
          ]),
        ),
      ).toEqual(expected);
    }
  });

  test('injects complete reproducible build metadata into application images', () => {
    const expected = {
      BUILD_CREATED: contractEnvironment.BUILD_CREATED,
      BUILD_REVISION: contractEnvironment.BUILD_REVISION,
      BUILD_VERSION: contractEnvironment.BUILD_VERSION,
      SOURCE_DATE_EPOCH: contractEnvironment.SOURCE_DATE_EPOCH,
    };
    const deployment = renderCompose();
    for (const service of ['caddy', 'server', 'coturn']) {
      expect(deployment.services[service]?.build?.args).toMatchObject(expected);
    }
    for (const configuration of [
      renderRootCompose('docker-compose.yml'),
      renderRootCompose('docker-compose.external-db.yml'),
    ]) {
      expect(configuration.services.server?.build?.args).toMatchObject(
        expected,
      );
      expect(configuration.services.coturn?.build?.args).toMatchObject(
        expected,
      );
    }

    const integration = renderCompose(true);
    const integrationExpected = {
      BUILD_CREATED: '1970-01-01T00:00:01Z',
      BUILD_REVISION: '0000000000000000000000000000000000000000',
      BUILD_VERSION: 'integration',
      SOURCE_DATE_EPOCH: '1',
    };
    for (const service of ['caddy', 'server', 'coturn']) {
      expect(integration.services[service]?.build?.args).toMatchObject(
        integrationExpected,
      );
      expect(integration.services[service]?.image).toMatch(/:integration$/u);
    }
  });

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
      ].sort(),
    );
    for (const port of services.coturn?.ports ?? []) {
      expect(port.host_ip).toBe('0.0.0.0');
    }
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
      ]),
    );
  });

  test('uses an authenticated TURN allocation for container health', () => {
    const healthcheck = JSON.stringify(
      renderCompose().services.coturn?.healthcheck,
    );
    expect(healthcheck).toContain('/usr/local/bin/turn-healthcheck');
    expect(healthcheck).toContain('/run/secrets/turn_shared_secret');
    expect(healthcheck).toContain('TURN_INTERNAL_IP:-127.0.0.1');
    expect(healthcheck).not.toContain('cat /run/secrets');
    expect(healthcheck).not.toContain(' -W ');
    expect(healthcheck).not.toContain('turnutils_stunclient');
    expect(healthcheck).toContain('"interval":"1m0s"');
    expect(healthcheck).toContain('"retries":3');
    const probe = read('deploy/coturn/health-probe.c');
    expect(probe).toContain('HMAC(EVP_sha1()');
    expect(probe).toContain('(argc != 3 && argc != 4)');
    expect(probe).toContain('inet_pton(AF_INET, value, &address)');
    expect(probe).toContain('execv("/usr/bin/turnutils_uclient"');
    expect(probe).toContain('"--no-even-port"');
    expect(probe).toContain('argc == 4 ? argv[3] : "127.0.0.1"');
  });

  test('supports a fail-closed single-IPv4 TURN host-network mapping', () => {
    for (const configuration of [
      renderCompose(),
      renderRootCompose('docker-compose.yml'),
      renderRootCompose('docker-compose.external-db.yml'),
    ]) {
      expect(configuration.services.coturn?.environment?.TURN_INTERNAL_IP).toBe(
        '',
      );
    }

    const entrypoint = read('deploy/coturn/entrypoint.sh');
    for (const boundary of [
      'valid_ipv4 "${TURN_EXTERNAL_IP:-}"',
      'valid_ipv4 "$TURN_INTERNAL_IP"',
      'for (octet_index = 1; octet_index <= 4; octet_index += 1)',
      'ip -4 -o address show',
      'TURN_INTERNAL_IP is not assigned to a local interface',
      '"denied-peer-ip=$TURN_EXTERNAL_IP-$TURN_EXTERNAL_IP"',
      '"listening-ip=$TURN_INTERNAL_IP"',
      '"relay-ip=$TURN_INTERNAL_IP"',
      '"external-ip=$TURN_EXTERNAL_IP/$TURN_INTERNAL_IP"',
    ]) {
      expect(entrypoint).toContain(boundary);
    }
    expect(entrypoint).not.toContain('for (index =');
    expect(entrypoint).not.toContain('listening-ip=127.0.0.1');
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

  test('renders the explicit TURN host-network profile without Docker NAT', () => {
    const hostEnvironment = {
      TURN_NETWORK_MODE: 'host',
      TURN_INTERNAL_IP: '172.24.52.219',
      TURN_STATE_EMPTY_DIR: '/var/empty/wo-turn',
      TURN_RELAY_MIN_PORT: '49160',
      TURN_RELAY_MAX_PORT: '49509',
    };
    for (const configuration of [
      renderCompose(false, hostEnvironment),
      renderRootCompose('docker-compose.yml', hostEnvironment),
      renderRootCompose('docker-compose.external-db.yml', hostEnvironment),
    ]) {
      const coturn = configuration.services.coturn!;
      expect(coturn.network_mode).toBe('host');
      expect(coturn.ports ?? []).toEqual([]);
      expect(serviceNetworks(coturn)).toEqual([]);
      expect(coturn.environment).toMatchObject({
        TURN_INTERNAL_IP: '172.24.52.219',
        TURN_LISTEN_PORT: '3478',
        TURN_NETWORK_MODE: 'host',
        TURN_RELAY_MAX_PORT: '49509',
        TURN_RELAY_MIN_PORT: '49160',
        TURN_TLS_LISTEN_PORT: '5349',
      });
      expect(serviceSecrets(coturn).sort()).toEqual([
        'turn_shared_secret',
        'turn_tls_cert',
        'turn_tls_key',
      ]);
      expect(coturn.volumes).toEqual([
        expect.objectContaining({
          read_only: true,
          source: '/var/empty/wo-turn',
          target: '/var/lib/coturn',
          type: 'bind',
        }),
      ]);
      expect(coturn.read_only).toBe(true);
      expect(coturn.cap_drop).toEqual(['ALL']);
      expect(coturn.security_opt).toContain('no-new-privileges:true');
    }
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
    expect(
      configuration.services.coturn?.tmpfs?.some((entry) =>
        entry.startsWith('/run/wo-turn:uid=0,gid=0,mode=0700'),
      ),
    ).toBe(true);
    expect(configuration.services.coturn?.user).toBe('0:0');
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      '"$runtime_tls_key" \\\n  /run/wo-turn',
    );
    expect(read('deploy/coturn/entrypoint.sh')).toContain(
      'chmod 600 "$runtime_config" "$runtime_tls_key"',
    );
    const turnEntrypoint = read('deploy/coturn/entrypoint.sh');
    expect(turnEntrypoint).toContain(
      'exec /usr/local/bin/wo-drop-privileges \\\n  65534 \\\n  65533 \\\n  /usr/bin/turnserver',
    );
    const turnPrivilegeDropper = read('deploy/coturn/drop-privileges.c');
    for (const privilegeBoundary of [
      'prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)',
      'prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)',
      'prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)',
      'setgroups(0, NULL)',
      'setresgid(gid, gid, gid)',
      'setresuid(uid, uid, uid)',
      'verify_capabilities_cleared(last)',
    ]) {
      expect(turnPrivilegeDropper).toContain(privilegeBoundary);
    }
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

  test('enforces runtime resource, filesystem, capability, and log boundaries', () => {
    const { services } = renderCompose();
    const boundaries = [
      {
        service: services.server!,
        memory: 512 * 1024 * 1024,
        pids: 128,
        capabilities: ['SETGID', 'SETPCAP', 'SETUID'],
      },
      {
        service: services.coturn!,
        memory: 256 * 1024 * 1024,
        pids: 64,
        capabilities: ['CHOWN', 'SETGID', 'SETPCAP', 'SETUID'],
      },
    ];

    for (const { service, memory, pids, capabilities } of boundaries) {
      expect(service.read_only).toBe(true);
      expect(service.cap_drop).toEqual(['ALL']);
      expect(service.cap_add?.sort()).toEqual(capabilities);
      expect(service.security_opt).toContain('no-new-privileges:true');
      expect(Number(service.mem_limit)).toBe(memory);
      expect(service.pids_limit).toBe(pids);
      expect(service.logging).toEqual({
        driver: 'json-file',
        options: { 'max-file': '5', 'max-size': '10m' },
      });
    }

    const turnDockerfile = read('deploy/coturn/Dockerfile');
    expect(turnDockerfile).toContain(
      'cc -O2 -Wall -Wextra -static /tmp/drop-privileges.c',
    );
    expect(turnDockerfile).toContain(
      'COPY --from=probe-build /tmp/wo-drop-privileges /usr/local/bin/wo-drop-privileges',
    );
    expect(
      turnDockerfile.match(/FROM coturn\/coturn:4\.14\.0-r0-alpine@sha256:/gu),
    ).toHaveLength(1);
    expect(turnDockerfile).toContain(
      'coturn/coturn:4.14.0-r0-alpine@sha256:d3a11e8f6d9e1b0454531e307684a072bdd36c36b28daafb4f082aa1e5ebd2e4',
    );
    expect(turnDockerfile).toContain(
      'cp -p /usr/bin/turnserver /tmp/turnserver \\\n  && rm -f /usr/bin/turnserver \\\n  && mv /tmp/turnserver /usr/bin/turnserver',
    );
    expect(turnDockerfile).toContain('rm -f /var/log/apk.log');
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
      for (const boundary of [
        'allocation-default-address-family=ipv4',
        'no-dtls',
        'no-rfc5780',
        'no-tcp-relay',
        'no-auth-pings',
        'no-dynamic-ip-list',
        'no-dynamic-realms',
        'userdb=/run/wo-turn/turndb',
      ]) {
        expect(config).toContain(boundary);
      }
      expect(config).not.toMatch(/^cli(?:=|$)/mu);
      expect(config).not.toMatch(
        /^(?:no-loopback-peers|no-tlsv1|no-tlsv1_1)$/mu,
      );
    }
  });

  test('never mounts relaxed integration TURN policy in production', () => {
    expect(JSON.stringify(renderCompose())).not.toContain(
      'turnserver.integration.conf',
    );
  });
});

describe('external database Compose contract', () => {
  test('hardens the exact two-service topology used behind host OpenResty', () => {
    const configuration = renderRootCompose('docker-compose.external-db.yml');
    expect(Object.keys(configuration.services).sort()).toEqual([
      'coturn',
      'server',
    ]);
    expect(Object.keys(configuration.networks).sort()).toEqual([
      'edge',
      'turn_edge',
    ]);

    const server = configuration.services.server!;
    expect(server.build).toMatchObject({
      context: root,
      dockerfile: 'apps/server/Dockerfile',
    });
    expect(server.ports).toHaveLength(1);
    expect(server.ports?.[0]).toMatchObject({
      host_ip: '127.0.0.1',
      protocol: 'tcp',
      published: '18080',
      target: 3000,
    });
    expect(serviceNetworks(server)).toEqual(['edge']);
    expect(serviceSecrets(server).sort()).toEqual([
      'jwt_access_secret',
      'postgres_password',
      'turn_shared_secret',
    ]);
    expect(server.volumes).toContainEqual(
      expect.objectContaining({
        read_only: true,
        source: resolve(root, 'downloads'),
        target: '/app/downloads',
        type: 'bind',
      }),
    );

    const coturn = configuration.services.coturn!;
    expect(coturn.build).toMatchObject({
      context: root,
      dockerfile: 'deploy/coturn/Dockerfile',
    });
    expect(coturn.ports).toHaveLength(44);
    for (const port of coturn.ports ?? []) {
      expect(port.host_ip).toBe('0.0.0.0');
    }
    expect(serviceNetworks(coturn)).toEqual(['turn_edge']);
    expect(serviceSecrets(coturn).sort()).toEqual([
      'turn_shared_secret',
      'turn_tls_cert',
      'turn_tls_key',
    ]);

    for (const [service, memory, pids, capabilities] of [
      [server, 512 * 1024 * 1024, 128, ['SETGID', 'SETPCAP', 'SETUID']],
      [coturn, 256 * 1024 * 1024, 64, ['CHOWN', 'SETGID', 'SETPCAP', 'SETUID']],
    ] as const) {
      expect(service.read_only).toBe(true);
      expect(service.cap_drop).toEqual(['ALL']);
      expect(service.cap_add?.sort()).toEqual(capabilities);
      expect(service.security_opt).toContain('no-new-privileges:true');
      expect(Number(service.mem_limit)).toBe(memory);
      expect(service.pids_limit).toBe(pids);
      expect(service.logging).toEqual({
        driver: 'json-file',
        options: { 'max-file': '5', 'max-size': '10m' },
      });
    }

    expect(server.tmpfs).toContain(
      '/tmp:uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev',
    );
    expect(coturn.tmpfs).toContain(
      '/run/wo-turn:uid=0,gid=0,mode=0700,size=4m,noexec,nosuid,nodev',
    );
    for (const [secretName, fileName] of [
      ['jwt_access_secret', 'jwt_access_secret'],
      ['postgres_password', 'postgres_password'],
      ['turn_shared_secret', 'turn_shared_secret'],
      ['turn_tls_cert', 'turn_tls_cert.pem'],
      ['turn_tls_key', 'turn_tls_key.pem'],
    ]) {
      expect(configuration.secrets?.[secretName]?.file).toBe(
        resolve(deploy, 'secrets', fileName),
      );
    }
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

  test('keeps default edge ports and permits explicit high-port integration bindings', () => {
    const edgePortKeys = (configuration: ComposeConfiguration) =>
      (configuration.services.caddy?.ports ?? []).map(portKey).sort();
    expect(edgePortKeys(renderCompose(true))).toEqual([
      '443-443:443-443/tcp',
      '80-80:80-80/tcp',
    ]);
    expect(
      edgePortKeys(
        renderCompose(true, {
          WO_INTEGRATION_HTTP_PORT: '18080',
          WO_INTEGRATION_HTTPS_PORT: '18443',
        }),
      ),
    ).toEqual(['18080-18080:80-80/tcp', '18443-18443:443-443/tcp']);
  });

  test('uses a separate local CA and relaxed TURN config without exporting CA keys', () => {
    const configuration = renderCompose(true);
    const serverEnvironment = configuration.services.server?.environment ?? {};
    expect(serverEnvironment.EMAIL_VERIFICATION_REQUIRED).toBe('false');
    expect(serverEnvironment.SMTP_HOST).toBe('');
    expect(serverEnvironment.SMTP_USER).toBe('');
    expect(serverEnvironment.SMTP_PASS).toBe('');
    expect(serverEnvironment.SMTP_FROM).toBe('');
    expect(JSON.stringify(configuration.services.caddy?.volumes)).toContain(
      'Caddyfile.integration',
    );
    expect(read('deploy/caddy/Caddyfile.integration')).toContain(
      'tls internal',
    );
    expect(read('deploy/caddy/Caddyfile.integration')).toContain('127.0.0.1');
    expect(read('deploy/caddy/Caddyfile.integration')).toContain(
      'default_sni 127.0.0.1',
    );
    expect(JSON.stringify(configuration.services.coturn?.volumes)).toContain(
      'turnserver.integration.conf',
    );
    expect(read('deploy/coturn/turnserver.integration.conf')).toContain(
      'allow-loopback-peers',
    );
    expect(read('deploy/coturn/turnserver.integration.conf')).toContain(
      'relay-threads=1',
    );
    expect(read('deploy/coturn/turnserver.conf')).not.toContain(
      'allow-loopback-peers',
    );
    expect(read('deploy/coturn/turnserver.conf')).not.toContain(
      'relay-threads=1',
    );
    expect(JSON.stringify(configuration)).not.toMatch(
      /pki\/authorities\/local|pki\\authorities\\local/,
    );
    expect(
      configuration.services.server?.environment?.TURN_URLS?.split(','),
    ).toContain('turns:turn.localhost:5349?transport=tcp');
  });
});
