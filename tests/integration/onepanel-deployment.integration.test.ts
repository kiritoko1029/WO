import { spawnSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { connect } from 'node:tls';
import { describe, expect, test } from 'vitest';
import {
  configureSetup,
  managedActionCommands,
  managedComposeArguments,
  managedProcessEnvironment,
  onePanelProxyConfiguration,
} from '../../deploy/scripts/setup.mjs';

const root = resolve(import.meta.dirname, '../..');
const acmeImage =
  'neilpang/acme.sh@sha256:5e5713c64816ca2f2dde780df87bc7464e6f6a5995d457710131b688317b8352';
const openrestyImage =
  'openresty/openresty@sha256:b3a6f1f432eabdbda4adcb6ec3e6461e621782eaa82dbe67154ddd1afd109569';
interface WireSocket {
  once(event: string, handler: (...args: unknown[]) => void): void;
  on(event: string, handler: (data: Buffer) => void): void;
  send(message: string): void;
  terminate(): void;
  readyState: number;
}
const WebSocket = createRequire(resolve(root, 'apps/server/package.json'))(
  'ws',
) as new (
  url: string,
  protocols: string[],
  options: { ca: string; servername: string; headers: Record<string, string> },
) => WireSocket;

describe.skipIf(process.env.WO_ONEPANEL_TEST !== '1')(
  '1Panel external ingress',
  () => {
    test('keeps public ports free, proxies HTTPS/WSS and follows directory certificate replacement for TURN', async () => {
      const project = `wo-panel-${randomUUID().slice(0, 8)}`;
      const fixture = await mkdtemp(join(tmpdir(), 'wo-onepanel-'));
      let setup: Awaited<ReturnType<typeof configureSetup>> | undefined;
      let socket: WireSocket | undefined;
      let attemptedStartup = false;
      const override = join(fixture, 'compose.json');
      const docker = (
        args: string[],
        timeout = 120_000,
        allowFailure = false,
      ) => {
        const result = spawnSync('docker', args, {
          cwd: root,
          encoding: 'utf8',
          timeout,
          windowsHide: true,
          env: managedProcessEnvironment(args),
        });
        if (!allowFailure && result.status !== 0)
          throw new Error(`Docker probe failed: ${result.stderr}`);
        return result;
      };
      const compose = (...args: string[]) =>
        docker([
          ...managedComposeArguments(setup!),
          '-f',
          override,
          ...args,
        ]).stdout.trim();
      const mount = (source: string, target: string) => ({
        type: 'bind',
        source,
        target,
        read_only: true,
        bind: { create_host_path: false },
      });
      const generate = (mode = 'normal') =>
        docker([
          'run',
          '--rm',
          '--network',
          'none',
          '--mount',
          `type=bind,src=${fixture},dst=/out`,
          '--mount',
          `type=bind,src=${resolve(root, 'tests/fixtures/onepanel-certificate.sh')},dst=/generate.sh,readonly`,
          '--entrypoint',
          'sh',
          acmeImage,
          '/generate.sh',
          mode,
        ]);
      try {
        generate();
        const sslDirectory = join(fixture, 'sites/test/ssl');
        const provenance = {
          BUILD_CREATED: '2026-09-12T00:00:00Z',
          BUILD_REVISION: 'a'.repeat(40),
          BUILD_VERSION: `2026.09.12-${'a'.repeat(12)}`,
          SOURCE_DATE_EPOCH: '1789171200',
        };
        setup = await configureSetup(
          {
            action: 'configure',
            '1panel': true,
            'non-interactive': true,
            project,
            domain: 'wo.panel.test',
            'admin-email': 'admin@example.com',
            'public-ip': '8.8.8.8',
            'cert-dir': '/opt/1panel/www/sites/test/ssl',
            'http-port': '19080',
            'turn-port': '19378',
            'turn-tls-port': '19349',
            'relay-min': '55200',
            'relay-max': '55205',
          },
          { platform: 'linux', provenanceProvider: () => provenance },
        );
        // Same generated location/header policy; the fixture uses an isolated
        // shared network instead of 1Panel's default host networking.
        await writeFile(
          join(fixture, 'location.conf'),
          onePanelProxyConfiguration(setup.environment).replace(
            'http://127.0.0.1:19080',
            'http://server:3000',
          ),
        );
        await writeFile(
          join(fixture, 'nginx.conf'),
          'events {}\nhttp { access_log off; server { listen 443 ssl; server_name wo.panel.test; ssl_certificate /site-ssl/fullchain.pem; ssl_certificate_key /site-ssl/privkey.pem; include /fixture/location.conf; } }\n',
        );
        await writeFile(
          override,
          JSON.stringify({
            services: {
              server: {
                image: 'wo-server:onepanel-check',
                pull_policy: 'never',
              },
              certificates: {
                image: 'wo-certificates:onepanel-check',
                pull_policy: 'never',
                volumes: [mount(sslDirectory, '/external-certs')],
              },
              coturn: {
                image: 'wo-coturn:apt-fix-check',
                pull_policy: 'never',
                environment: { TURN_EXTERNAL_IP: '127.0.0.1' },
                ports: [
                  '127.0.0.1:19378:3478/tcp',
                  '127.0.0.1:19378:3478/udp',
                  '127.0.0.1:19349:5349/tcp',
                ],
              },
              openresty: {
                image: openrestyImage,
                command: [
                  '/usr/local/openresty/bin/openresty',
                  '-c',
                  '/fixture/nginx.conf',
                  '-g',
                  'daemon off;',
                ],
                ports: ['127.0.0.1:19443:443'],
                networks: ['edge', 'api_internal'],
                volumes: [
                  mount(fixture, '/fixture'),
                  mount(sslDirectory, '/site-ssl'),
                ],
                depends_on: { server: { condition: 'service_healthy' } },
              },
            },
          }).replaceAll('"ports":[', '"ports": !override ['),
        );
        // Exercise the actual explicit Caddy removal command as well as the
        // default profile: it must neither start Caddy nor delete any volumes.
        const removeCaddy = managedActionCommands(setup, 'up')[0];
        docker(removeCaddy);
        attemptedStartup = true;
        compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120');
        const rows = compose('ps', '--format', 'json')
          .split(/\r?\n/u)
          .filter(Boolean)
          .map(
            (s) =>
              JSON.parse(s) as {
                Service: string;
                ID: string;
                Publishers?: Array<{ PublishedPort: number }>;
              },
          );
        expect(rows.map((row) => row.Service).sort()).toEqual([
          'certificates',
          'coturn',
          'openresty',
          'postgres',
          'server',
        ]);
        for (const row of rows.filter((r) => r.Service !== 'openresty')) {
          expect(
            (row.Publishers ?? []).some(
              (p) => p.PublishedPort === 80 || p.PublishedPort === 443,
            ),
          ).toBe(false);
        }
        const certificateId = compose('ps', '-q', 'certificates');
        expect(
          docker([
            'inspect',
            '--format',
            '{{.HostConfig.NetworkMode}}',
            certificateId,
          ]).stdout.trim(),
        ).toBe('none');
        const mounts = JSON.parse(
          docker(['inspect', '--format', '{{json .Mounts}}', certificateId])
            .stdout,
        ) as Array<{ Destination: string; RW: boolean }>;
        expect(
          mounts.find((m) => m.Destination === '/external-certs')?.RW,
        ).toBe(false);
        const ca = await readFile(join(fixture, 'ca.pem'), 'utf8');
        await expect
          .poll(
            () =>
              new Promise<number>((done) => {
                const probe = httpGet(
                  'http://127.0.0.1:19080/v1/health/ready',
                  (response) => {
                    response.resume();
                    done(response.statusCode ?? 0);
                  },
                );
                probe.on('error', () => done(0));
                probe.setTimeout(3000, () => {
                  probe.destroy();
                  done(0);
                });
              }),
            { timeout: 20_000, interval: 500 },
          )
          .toBe(200);
        const api = (
          path: string,
          body?: unknown,
          token?: string,
          method?: string,
        ) =>
          new Promise<{ status: number; body: unknown }>((done, reject) => {
            const data = body === undefined ? undefined : JSON.stringify(body);
            const req = request(
              {
                host: '127.0.0.1',
                port: 19443,
                servername: 'wo.panel.test',
                ca,
                agent: false,
                path,
                method: method ?? (data === undefined ? 'GET' : 'POST'),
                headers: {
                  host: 'wo.panel.test',
                  ...(data
                    ? {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(data),
                      }
                    : {}),
                  ...(token ? { authorization: `Bearer ${token}` } : {}),
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
                    /* HTML is intentional. */
                  }
                  done({ status: response.statusCode ?? 0, body: parsed });
                });
              },
            );
            req.on('error', reject);
            req.setTimeout(10_000, () =>
              req.destroy(new Error('HTTPS timeout')),
            );
            req.end(data);
          });
        const fingerprint = (port: number) =>
          new Promise<string>((done, reject) => {
            const peer = connect(
              { host: '127.0.0.1', port, servername: 'wo.panel.test', ca },
              () => {
                const value = peer.getPeerCertificate().fingerprint256;
                peer.end();
                done(value);
              },
            );
            peer.on('error', reject);
            peer.setTimeout(5000, () => peer.destroy(new Error('TLS timeout')));
          });
        expect((await api('/v1/health/ready')).status).toBe(200);
        expect(String((await api('/admin')).body)).toContain('WO');
        expect((await api('/v1/admin/deployment')).status).toBe(401);
        const password = (
          await readFile(
            join(setup.stateDirectory, 'secrets/bootstrap_admin_password'),
            'utf8',
          )
        ).replace(/\r?\n$/u, '');
        const login = await api('/v1/auth/login', {
          email: 'admin@example.com',
          password,
        });
        expect(login.status).toBe(200);
        const token = (login.body as { accessToken: string }).accessToken;
        const status = await api('/v1/admin/deployment', undefined, token);
        expect(status.status).toBe(200);
        expect(
          (status.body as { certificate: unknown }).certificate,
        ).toMatchObject({ mode: 'external', autoRenew: false, state: 'ready' });
        expect(JSON.stringify(status.body)).not.toContain('PRIVATE KEY');
        const ticket = await api(
          '/v1/realtime/ticket',
          undefined,
          token,
          'POST',
        );
        expect(ticket.status).toBe(200);
        socket = new WebSocket(
          'wss://127.0.0.1:19443/v1/realtime',
          ['wo-v1', `ticket.${(ticket.body as { ticket: string }).ticket}`],
          {
            ca,
            servername: 'wo.panel.test',
            headers: { host: 'wo.panel.test' },
          },
        );
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(
            () => reject(new Error('WSS timeout')),
            10_000,
          );
          socket!.once('open', () => {
            clearTimeout(timer);
            done();
          });
          socket!.once('error', () => {
            clearTimeout(timer);
            reject(new Error('WSS error'));
          });
        });
        const signal = (type: string, payload: unknown) =>
          new Promise<Record<string, unknown>>((done, reject) => {
            const requestId = randomUUID();
            const timer = setTimeout(
              () => reject(new Error(`${type} timed out`)),
              10_000,
            );
            socket!.on('message', (data) => {
              const ack = JSON.parse(String(data)) as {
                requestId?: string;
                payload: { ok: boolean; data: Record<string, unknown> };
              };
              if (ack.requestId === requestId) {
                clearTimeout(timer);
                if (ack.payload.ok) done(ack.payload.data);
                else reject(new Error('Signaling rejected'));
              }
            });
            socket!.send(
              JSON.stringify({ version: 1, requestId, type, payload }),
            );
          });
        const room = await signal('room.create', {});
        const first = await fingerprint(19349);
        expect(await fingerprint(19443)).toBe(first);
        const ids = compose('ps', '-q').split(/\r?\n/u).sort();
        // Neither a combined private-key export nor an incomplete provider
        // update may replace the last usable TURN pair or leak into public status.
        for (const invalidMode of ['combined', 'wrong-key']) {
          generate(invalidMode);
          expect(
            docker(
              [
                ...managedComposeArguments(setup),
                '-f',
                override,
                'exec',
                '-T',
                'certificates',
                '/opt/wo/certificates.sh',
                '--sync-now',
              ],
              30_000,
              true,
            ).status,
          ).not.toBe(0);
          expect(
            JSON.parse(
              compose(
                'exec',
                '-T',
                'certificates',
                'cat',
                '/status/status.json',
              ),
            ).errorCode,
          ).toBe('IMPORT_FAILED');
          compose(
            'exec',
            '-T',
            'certificates',
            'sh',
            '-c',
            '! grep -q "PRIVATE KEY" /status/certificate.pem',
          );
          expect(await fingerprint(19349)).toBe(first);
        }
        generate();
        compose(
          'exec',
          '-T',
          'openresty',
          '/usr/local/openresty/bin/openresty',
          '-c',
          '/fixture/nginx.conf',
          '-s',
          'reload',
        );
        const expected = new X509Certificate(
          await readFile(join(sslDirectory, 'fullchain.pem')),
        ).fingerprint256;
        expect(expected === first).toBe(false);
        // No manual sync here: prove the production 30-second watcher observes
        // directory-mounted files replaced by the certificate owner.
        await expect
          .poll(
            async () => {
              try {
                return await fingerprint(19349);
              } catch {
                return '';
              }
            },
            { timeout: 60_000, interval: 1000 },
          )
          .toBe(expected);
        expect(await fingerprint(19443)).toBe(expected);
        expect(compose('ps', '-q').split(/\r?\n/u).sort()).toEqual(ids);
        expect(socket.readyState).toBe(1);
        await signal('room.end', { roomId: room.roomId });
        compose(
          'exec',
          '-T',
          'certificates',
          'sh',
          '-c',
          'test ! -d /acme.sh/domains',
        );
      } catch (error) {
        if (setup && attemptedStartup) {
          const logs = docker(
            [
              ...managedComposeArguments(setup),
              '-f',
              override,
              'logs',
              '--tail',
              '25',
              'openresty',
            ],
            30_000,
            true,
          );
          console.error(logs.stdout + logs.stderr);
        }
        throw error;
      } finally {
        socket?.terminate();
        if (setup && attemptedStartup)
          docker(
            [
              ...managedComposeArguments(setup),
              '-f',
              override,
              'down',
              '--volumes',
              '--remove-orphans',
            ],
            120_000,
          );
        if (
          setup &&
          setup.stateDirectory.startsWith(
            resolve(root, 'deploy/.managed') + sep,
          )
        )
          await rm(setup.stateDirectory, { recursive: true, force: true });
        if (resolve(fixture).startsWith(resolve(tmpdir()) + sep))
          await rm(fixture, { recursive: true, force: true });
      }
    }, 240_000);
  },
);
