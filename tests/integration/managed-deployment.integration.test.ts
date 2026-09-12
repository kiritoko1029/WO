import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  configureSetup,
  managedComposeArguments,
  managedProcessEnvironment,
} from '../../deploy/scripts/setup.mjs';
import { adminDeploymentStatusSchema } from '../../packages/protocol/src/admin.ts';

const root = resolve(import.meta.dirname, '../..');
const project = 'wo-managed-acceptance';
const stateDirectory = resolve(root, 'deploy/.managed', project);
const enabled = process.env.WO_MANAGED_STACK_TEST === '1';

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { userId: string };
}
interface Socket {
  readyState: number;
  once(event: string, listener: (...args: unknown[]) => void): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  send(value: string): void;
  terminate(): void;
}
const WebSocket = createRequire(resolve(root, 'apps/server/package.json'))(
  'ws',
) as new (
  url: string,
  protocols: string[],
  options: { ca: string; servername: string; headers: Record<string, string> },
) => Socket;

// Runs only against the explicitly prepared, loopback-only acceptance project.
// Lifecycle remains with the guided setup: this suite never deletes a stack.
describe.skipIf(!enabled)('managed Docker deployment', () => {
  let setup: Awaited<ReturnType<typeof configureSetup>>;
  let authority: string;
  let ca: string;
  let admin: Session;
  let guest: Session;
  let roomId: string;
  const sockets: Socket[] = [];
  const clients: Array<
    (
      type: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
  > = [];

  function docker(args: string[]): string {
    const result = spawnSync('docker', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      env: managedProcessEnvironment(args),
    });
    if (result.status !== 0)
      throw new Error(`Docker check failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }
  const compose = (...args: string[]) =>
    docker(managedComposeArguments(setup, ...args));

  async function copyPublicCertificate(): Promise<string> {
    const id = compose('ps', '-q', 'certificates');
    const file = resolve(stateDirectory, 'acceptance-public-ca.pem');
    docker(['cp', `${id}:/status/certificate.pem`, file]);
    return readFile(file, 'utf8');
  }

  function api(
    path: string,
    body?: unknown,
    token?: string,
    method?: 'GET' | 'POST',
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolveResponse, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(setup.environment.WO_HTTPS_PORT),
          servername: 'wo.localhost',
          path,
          ca,
          agent: false,
          method: method ?? (data === undefined ? 'GET' : 'POST'),
          headers: {
            host: authority,
            ...(data === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(data),
                }),
            ...(token === undefined
              ? {}
              : { authorization: `Bearer ${token}` }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* Static responses are text. */
            }
            resolveResponse({ status: response.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10_000, () =>
        req.destroy(new Error('HTTPS request timed out')),
      );
      req.end(data);
    });
  }

  function tlsFingerprint(port: number): Promise<string> {
    return new Promise((resolveFingerprint, reject) => {
      const socket = connectTls(
        { host: '127.0.0.1', port, servername: 'wo.localhost', ca },
        () => {
          const fingerprint = socket.getPeerCertificate().fingerprint256;
          socket.end();
          resolveFingerprint(fingerprint);
        },
      );
      socket.on('error', reject);
      socket.setTimeout(5_000, () =>
        socket.destroy(new Error('TLS probe timed out')),
      );
    });
  }

  async function signaling(session: Session) {
    const issued = await api(
      '/v1/realtime/ticket',
      undefined,
      session.accessToken,
      'POST',
    );
    expect(issued.status).toBe(200);
    const ticket = (issued.body as { ticket: string }).ticket;
    const socket = new WebSocket(
      `wss://127.0.0.1:${setup.environment.WO_HTTPS_PORT}/v1/realtime`,
      ['wo-v1', `ticket.${ticket}`],
      {
        ca,
        servername: 'wo.localhost',
        headers: { host: authority },
      },
    );
    sockets.push(socket);
    await new Promise<void>((resolveOpen, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('WSS open timed out'));
      }, 10_000);
      socket.once('open', () => {
        clearTimeout(timeout);
        resolveOpen();
      });
      socket.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('WSS failed'));
      });
    });
    const waiting = new Map<
      string,
      {
        resolve: (data: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as {
        requestId?: string;
        payload?: { ok: boolean; data: Record<string, unknown> };
      };
      const item =
        message.requestId === undefined
          ? undefined
          : waiting.get(message.requestId);
      if (item === undefined) return;
      waiting.delete(message.requestId!);
      clearTimeout(item.timer);
      if (message.payload?.ok === true) item.resolve(message.payload.data);
      else item.reject(new Error('Signaling request rejected'));
    });
    const send = (type: string, payload: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolveAck, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(new Error(`${type} timed out`));
        }, 10_000);
        waiting.set(requestId, { resolve: resolveAck, reject, timer });
        socket.send(JSON.stringify({ version: 1, requestId, type, payload }));
      });
    clients.push(send);
    return send;
  }

  beforeAll(async () => {
    // Require an existing explicitly local setup before reading its test secret.
    const manifest = JSON.parse(
      await readFile(resolve(stateDirectory, 'settings.json'), 'utf8'),
    ) as { environment: { WO_TLS_MODE: string } };
    if (manifest.environment.WO_TLS_MODE !== 'local')
      throw new Error('This suite requires the local acceptance deployment');
    setup = await configureSetup({
      action: 'configure',
      local: true,
      'non-interactive': true,
      project,
      'state-dir': 'deploy/.managed/wo-managed-acceptance',
    });
    authority = new URL(setup.environment.WO_PUBLIC_ORIGIN).host;
    ca = await copyPublicCertificate();
    const password = (
      await readFile(
        resolve(stateDirectory, 'secrets/bootstrap_admin_password'),
        'utf8',
      )
    ).replace(/\r?\n$/u, '');
    const login = await api('/v1/auth/login', {
      email: setup.environment.BOOTSTRAP_ADMIN_EMAIL,
      password,
    });
    expect(login.status).toBe(200);
    admin = login.body as Session;
  }, 90_000);

  afterAll(async () => {
    if (roomId && clients[0])
      await clients[0]('room.end', { roomId }).catch(() => undefined);
    for (const socket of sockets) socket.terminate();
    for (const session of [admin, guest]) {
      if (session)
        await api('/v1/auth/logout', {
          refreshToken: session.refreshToken,
        }).catch(() => undefined);
    }
  });

  test('boots all five services with owner labels, trusted HTTPS and verified administrator', async () => {
    const services = compose('ps', '--format', 'json')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            Service: string;
            Health: string;
            ID: string;
            Publishers?: Array<{ URL?: string; PublishedPort: number }>;
          },
      );
    expect(services.map((s) => s.Service).sort()).toEqual([
      'caddy',
      'certificates',
      'coturn',
      'postgres',
      'server',
    ]);
    for (const service of services) {
      expect(service.Health).toBe('healthy');
      expect(
        docker([
          'inspect',
          '--format',
          '{{index .Config.Labels "io.wo.managed.deployment-id"}}',
          service.ID,
        ]),
      ).toBe(setup.environment.WO_DEPLOYMENT_ID);
      for (const port of service.Publishers ?? [])
        if (port.PublishedPort > 0) expect(port.URL).toBe('127.0.0.1');
      if (service.Service === 'server' || service.Service === 'coturn') {
        const startupCapabilities = JSON.parse(
          docker([
            'inspect',
            '--format',
            '{{json .HostConfig.CapAdd}}',
            service.ID,
          ]),
        ) as string[];
        expect(
          startupCapabilities.map((value) => value.replace(/^CAP_/u, '')),
        ).toContain('DAC_READ_SEARCH');
        const processStatus = compose(
          'exec',
          '-T',
          service.Service,
          'cat',
          '/proc/1/status',
        );
        const uid = service.Service === 'server' ? '1000' : '65534';
        expect(processStatus).toMatch(
          new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, 'm'),
        );
        expect(processStatus).toMatch(/^NoNewPrivs:\s+1$/m);
        for (const kind of ['Inh', 'Prm', 'Eff', 'Bnd', 'Amb']) {
          expect(processStatus).toMatch(new RegExp(`^Cap${kind}:\\s+0+$`, 'm'));
        }
      }
    }
    expect((await api('/v1/health/ready')).status).toBe(200);
    expect(
      (await api('/v1/admin/me', undefined, admin.accessToken)).body,
    ).toEqual({ admin: true });
    const response = await api(
      '/v1/admin/deployment',
      undefined,
      admin.accessToken,
    );
    expect(response.status).toBe(200);
    const status = adminDeploymentStatusSchema.parse(response.body);
    expect(status.certificate.state).toBe('ready');
    expect(status.certificate.mode).toBe('local');
    expect(status.certificate.details?.matchesPublicHost).toBe(true);
    expect(status.certificate.details?.matchesTurnHost).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /PRIVATE KEY|bootstrap_admin_password|jwt_access_secret|\/run\//u,
    );
    expect(await tlsFingerprint(Number(setup.environment.TURN_TLS_PORT))).toBe(
      new X509Certificate(ca).fingerprint256,
    );
    compose(
      'exec',
      '-T',
      'coturn',
      '/usr/local/bin/turn-healthcheck',
      '/run/secrets/turn_shared_secret',
      '3478',
      '127.0.0.1',
    );
  }, 60_000);

  test('protects admin data and keeps two WSS participants connected while HTTPS and TURN certificates rotate', async () => {
    expect((await api('/v1/admin/deployment')).status).toBe(401);
    const registered = await api('/v1/auth/register', {
      email: `managed-${randomBytes(6).toString('hex')}@example.com`,
      password: randomBytes(24).toString('base64url'),
      displayName: 'Deployment guest',
    });
    expect(registered.status).toBe(201);
    guest = registered.body as Session;
    expect(
      (await api('/v1/admin/deployment', undefined, guest.accessToken)).status,
    ).toBe(403);
    const creator = await signaling(admin);
    const joiner = await signaling(guest);
    const created = await creator('room.create', {});
    roomId = String(created.roomId);
    const joined = await joiner('room.join', { roomCode: created.roomCode });
    expect(joined.roomId).toBe(roomId);
    await creator('peer.ready', {
      roomId,
      connectionEpoch: created.connectionEpoch,
      mediaPlan: 'mic-system-screen-v1',
    });
    await joiner('peer.ready', {
      roomId,
      connectionEpoch: joined.connectionEpoch,
      mediaPlan: 'mic-system-screen-v1',
    });
    const negotiationId = randomUUID();
    await creator('webrtc.offer', {
      roomId,
      connectionEpoch: created.connectionEpoch,
      negotiationId,
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await joiner('webrtc.answer', {
      roomId,
      connectionEpoch: joined.connectionEpoch,
      negotiationId,
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await creator('webrtc.answerApplied', {
      roomId,
      connectionEpoch: created.connectionEpoch,
      negotiationId,
    });
    const old = new X509Certificate(ca).fingerprint256;
    const before = compose('ps', '-q').split(/\r?\n/u).sort();
    compose(
      'exec',
      '-T',
      'certificates',
      '/opt/wo/certificates.sh',
      '--renew-now',
    );
    const renewed = await copyPublicCertificate();
    const expected = new X509Certificate(renewed).fingerprint256;
    expect(expected === old).toBe(false);
    ca += `\n${renewed}`;
    await expect
      .poll(
        async () => {
          try {
            return await tlsFingerprint(
              Number(setup.environment.WO_HTTPS_PORT),
            );
          } catch {
            return '';
          }
        },
        { timeout: 60_000, interval: 1_000 },
      )
      .toBe(expected);
    await expect
      .poll(
        async () => {
          try {
            return await tlsFingerprint(
              Number(setup.environment.TURN_TLS_PORT),
            );
          } catch {
            return '';
          }
        },
        { timeout: 60_000, interval: 1_000 },
      )
      .toBe(expected);
    expect(compose('ps', '-q').split(/\r?\n/u).sort()).toEqual(before);
    expect(sockets.every((socket) => socket.readyState === 1)).toBe(true);
    const acquired = await clients[0]!('screen.acquire', { roomId });
    await clients[0]!('screen.release', {
      roomId,
      leaseId: (acquired.lease as { leaseId: string }).leaseId,
    });
    const status = adminDeploymentStatusSchema.parse(
      (await api('/v1/admin/deployment', undefined, admin.accessToken)).body,
    );
    expect(status.certificate.details?.fingerprint256).toBe(expected);
  }, 150_000);
});
