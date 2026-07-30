import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as tls from 'node:tls';

import {
  argumentValue,
  composeProcessEnvironment,
  deployDirectory,
  hasArgument,
  integrationComposeArguments,
  loadDeploymentEnvironment,
} from './ops.mjs';

const timeoutMilliseconds = 8_000;
const proxyReloadIdleMilliseconds = timeoutMilliseconds + 1_000;
const smokeAccountCount = 3;
const smokeEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const turnProofInvalidHostname = 'wo-turn-proof.invalid';
export const smokeP2pMediaPlan = 'mic-system-screen-v1';

export function productionSmokeAccounts(environment) {
  const emails = (environment.DEPLOY_SMOKE_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  if (
    emails.length !== smokeAccountCount ||
    new Set(emails).size !== smokeAccountCount
  ) {
    throw new Error(
      'DEPLOY_SMOKE_EMAILS must contain exactly three unique accounts',
    );
  }

  const allowlist = new Set(
    (environment.EMAIL_DOMAIN_ALLOWLIST ?? '')
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain.length > 0),
  );
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (
      !smokeEmailPattern.test(email) ||
      domain === 'invalid' ||
      domain.endsWith('.invalid')
    ) {
      throw new Error('DEPLOY_SMOKE_EMAILS contains an invalid account');
    }
    if (allowlist.size > 0 && !allowlist.has(domain)) {
      throw new Error(
        'DEPLOY_SMOKE_EMAILS contains an account outside EMAIL_DOMAIN_ALLOWLIST',
      );
    }
  }

  const password = environment.DEPLOY_SMOKE_PASSWORD ?? '';
  if (password.length < 10 || password.length > 128) {
    throw new Error('DEPLOY_SMOKE_PASSWORD must contain 10 to 128 characters');
  }
  return emails.map((email) => ({ email, password }));
}

export function smokeAuthenticationRequests(environment, integration = false) {
  if (!integration) {
    return productionSmokeAccounts(environment).map((account) => ({
      body: account,
      expectedStatus: 200,
      path: '/v1/auth/login',
    }));
  }
  const runId = randomBytes(8).toString('hex');
  const password = randomBytes(24).toString('base64url');
  return Array.from({ length: smokeAccountCount }, (_, index) => ({
    body: {
      email: `smoke-${runId}-${index}@example.invalid`,
      password,
      displayName: `Smoke ${index + 1}`,
    },
    expectedStatus: 201,
    path: '/v1/auth/register',
  }));
}

async function responseJson(response, expectedStatus, operation) {
  if (response.status !== expectedStatus) {
    throw new Error(`${operation} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(
  baseUrl,
  path,
  body,
  accessToken,
  expectedStatus = 200,
) {
  const headers = { 'content-type': 'application/json' };
  if (accessToken !== undefined) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  const response = await fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  return responseJson(response, expectedStatus, path);
}

async function issueTicket(baseUrl, accessToken) {
  const response = await fetch(new URL('/v1/realtime/ticket', baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  return responseJson(response, 200, '/v1/realtime/ticket');
}

class SignalingClient {
  #messages = [];
  #waiters = [];

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiterIndex = this.#waiters.findIndex(({ predicate }) =>
        predicate(message),
      );
      if (waiterIndex === -1) {
        this.#messages.push(message);
        return;
      }
      const [waiter] = this.#waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    });
  }

  send(type, requestId, payload) {
    this.socket.send(JSON.stringify({ version: 1, requestId, type, payload }));
  }

  next(predicate, label) {
    const existingIndex = this.#messages.findIndex(predicate);
    if (existingIndex !== -1) {
      return Promise.resolve(this.#messages.splice(existingIndex, 1)[0]);
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: resolvePromise,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) {
            this.#waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMilliseconds),
      };
      this.#waiters.push(waiter);
    });
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1000, 'smoke complete');
    }
  }
}

async function connect(baseUrl, ticket) {
  const websocketUrl = new URL('/v1/realtime', baseUrl);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(websocketUrl, ['wo-v1', `ticket.${ticket}`]);
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out opening signaling connection')),
      timeoutMilliseconds,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        if (socket.protocol !== 'wo-v1') {
          reject(new Error('Signaling subprotocol was not negotiated'));
          return;
        }
        resolvePromise();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('Signaling connection failed'));
      },
      { once: true },
    );
  });
  return new SignalingClient(socket);
}

const isAck = (requestId) => (message) =>
  message.requestId === requestId && message.type?.endsWith('.ack');
const isBroadcast = (type) => (message) =>
  message.type === type && typeof message.eventId === 'string';

function successData(message, operation) {
  if (message.payload?.ok !== true) {
    throw new Error(
      `${operation} failed (${message.payload?.error?.code ?? 'unknown error'})`,
    );
  }
  return message.payload.data;
}

async function successfulRequest(client, type, payload) {
  const requestId = randomUUID();
  client.send(type, requestId, payload);
  return successData(await client.next(isAck(requestId), `${type} ack`), type);
}

async function rejectedRequest(client, type, payload, expectedCode) {
  const requestId = randomUUID();
  client.send(type, requestId, payload);
  const message = await client.next(isAck(requestId), `${type} rejection`);
  if (
    message.payload?.ok !== false ||
    message.payload?.error?.code !== expectedCode
  ) {
    throw new Error(`${type} did not return ${expectedCode}`);
  }
}

async function waitUntilReady(baseUrl) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/v1/health/ready', baseUrl), {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The service may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error('HTTPS readiness timed out');
}

function maybeRestartWithCa() {
  const caFile = argumentValue('--ca-file');
  if (caFile === undefined || process.env.WO_SMOKE_CA_ACTIVE === '1') {
    return false;
  }
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: resolve(caFile),
      WO_SMOKE_CA_ACTIVE: '1',
    },
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
  return true;
}

function turnCredentials(session, environment) {
  const server = session.rtcConfiguration?.iceServers?.find(
    ({ urls, username, credential }) =>
      Array.isArray(urls) &&
      urls.some((url) => url.startsWith('turn:')) &&
      typeof username === 'string' &&
      typeof credential === 'string',
  );
  if (server === undefined) {
    throw new Error('Server did not issue TURN credentials');
  }
  const expiresAt = Date.parse(session.iceCredentialsExpiresAt);
  const maximumExpiration =
    Date.now() +
    Number(environment.TURN_CREDENTIAL_TTL_SECONDS ?? 600) * 1_000 +
    5_000;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > maximumExpiration ||
    !server.username.startsWith(`${Math.floor(expiresAt / 1_000)}:`)
  ) {
    throw new Error('Server issued an invalid TURN credential lifetime');
  }
  return { username: server.username, credential: server.credential };
}

export function createExpiredTurnCredentials(
  credentials,
  sharedSecret,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const separatorIndex =
    typeof credentials?.username === 'string'
      ? credentials.username.indexOf(':')
      : -1;
  if (
    separatorIndex < 1 ||
    separatorIndex === credentials.username.length - 1 ||
    typeof sharedSecret !== 'string' ||
    sharedSecret.length === 0 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 1
  ) {
    throw new TypeError('TURN expiration proof input is invalid');
  }
  const username = `${nowSeconds - 1}${credentials.username.slice(separatorIndex)}`;
  return Object.freeze({
    username,
    credential: createHmac('sha1', sharedSecret)
      .update(username, 'utf8')
      .digest('base64'),
  });
}

async function readTurnSharedSecret(environment) {
  const secret = (
    await readFile(
      resolve(
        deployDirectory,
        environment.DEPLOY_SECRET_DIR,
        'turn_shared_secret',
      ),
      'utf8',
    )
  ).replace(/[\r\n]+$/u, '');
  if (secret.length === 0) {
    throw new Error('TURN shared secret is empty');
  }
  return secret;
}

const turnClientScript = String.raw`
set -eu
username="$1"
credential="$2"
transport="$3"
peer_log="/run/wo-turn/wo-turn-peer-$$.log"
turnutils_peer -L 127.0.0.1 -p 3480 >"$peer_log" 2>&1 &
peer_pid=$!
cleanup() {
  kill "$peer_pid" 2>/dev/null || true
  wait "$peer_pid" 2>/dev/null || true
  rm -f "$peer_log"
}
trap cleanup EXIT
sleep 1
if ! kill -0 "$peer_pid" 2>/dev/null; then
  cat "$peer_log" >&2
  exit 1
fi
case "$transport" in
  tls)
    turnutils_uclient -u "$username" -w "$credential" -S -t -E /run/secrets/turn_tls_cert -c -n 3 -e 127.0.0.1 -r 3480 -p 5349 127.0.0.1
    ;;
  tcp)
    turnutils_uclient -u "$username" -w "$credential" -t -c -n 3 -e 127.0.0.1 -r 3480 -p 3478 127.0.0.1
    ;;
  udp)
    turnutils_uclient -u "$username" -w "$credential" -c -n 3 -e 127.0.0.1 -r 3480 -p 3478 127.0.0.1
    ;;
  *)
    printf '%s\n' 'Unsupported TURN proof transport' >&2
    exit 2
    ;;
esac
`;

function runTurnClient(envFile, credentials, transport, shouldPass) {
  const composeCommand = integrationComposeArguments(
    envFile,
    'exec',
    '-T',
    '--user',
    '65534:65533',
    'coturn',
    'sh',
    '-ec',
    turnClientScript,
    'wo-turn-proof',
    credentials.username,
    credentials.credential,
    transport,
  );
  const result = spawnSync('docker', composeCommand, {
    cwd: deployDirectory,
    encoding: 'utf8',
    env: composeProcessEnvironment(composeCommand),
    timeout: 30_000,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    !Number.isInteger(result.status)
  ) {
    throw new Error('TURN proof process did not complete');
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (shouldPass) {
    const receivedCounts = [...output.matchAll(/tot_recv_msgs=([0-9]+)/gu)].map(
      (match) => Number(match[1]),
    );
    const maximumReceived =
      receivedCounts.length === 0 ? undefined : Math.max(...receivedCounts);
    if (
      result.status !== 0 ||
      maximumReceived === undefined ||
      maximumReceived < 1
    ) {
      throw new Error(
        `Authenticated TURN client exchanged no relay data (status=${result.status}, max-received=${maximumReceived ?? 'missing'})`,
      );
    }
  } else if (
    result.status === 0 ||
    !/(?:401|unauthori[sz]ed|wrong credentials|authentication failed|cannot complete allocation)/iu.test(
      output,
    )
  ) {
    throw new Error(
      result.status === 0
        ? 'TURN accepted invalid credentials'
        : 'TURN credential rejection was inconclusive',
    );
  }
}

async function connectTurnTls(options) {
  await new Promise((resolvePromise, reject) => {
    const socket = tls.connect(options);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('TURN TLS handshake timed out'));
    }, timeoutMilliseconds);
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      socket.end();
      resolvePromise();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function connectionErrorCode(error) {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  try {
    return typeof error.code === 'string' ? error.code : undefined;
  } catch {
    return undefined;
  }
}

async function expectTurnTlsFailure(options, expectedCodes, label) {
  try {
    await connectTurnTls(options);
  } catch (error) {
    if (expectedCodes.includes(connectionErrorCode(error))) {
      return;
    }
    throw new Error(`${label} returned an unexpected failure`, {
      cause: error,
    });
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function verifyTurnTls(environment) {
  const certificate = await readFile(
    resolve(
      deployDirectory,
      environment.DEPLOY_SECRET_DIR,
      'turn_tls_cert.pem',
    ),
  );
  const port = Number(environment.TURN_TLS_PORT);
  await connectTurnTls({
    host: '127.0.0.1',
    port,
    servername: environment.TURN_HOST,
    ca: certificate,
    rejectUnauthorized: true,
  });
  return { certificate, port };
}

async function verifyTurnTlsFailures(environment, certificate, port) {
  await expectTurnTlsFailure(
    {
      host: '127.0.0.1',
      port,
      servername: turnProofInvalidHostname,
      ca: certificate,
      rejectUnauthorized: true,
    },
    ['ERR_TLS_CERT_ALTNAME_INVALID'],
    'TURN TLS hostname mismatch proof',
  );
  process.stdout.write('Smoke: TURN rejected an invalid TLS hostname\n');

  await expectTurnTlsFailure(
    {
      host: turnProofInvalidHostname,
      port,
      servername: turnProofInvalidHostname,
      ca: certificate,
      rejectUnauthorized: true,
    },
    ['ENOTFOUND'],
    'TURN DNS failure proof',
  );
  process.stdout.write('Smoke: TURN DNS failure was explicit\n');
}

async function verifyTurnProof(envFile, environment, session) {
  if (!hasArgument('--integration')) {
    throw new Error('TURN proof is restricted to the integration profile');
  }
  const credentials = turnCredentials(session, environment);
  runTurnClient(envFile, credentials, 'udp', true);
  process.stdout.write('Smoke: TURN relay data passed\n');

  runTurnClient(envFile, credentials, 'tcp', true);
  process.stdout.write(
    'Smoke: authenticated TURN-over-TCP UDP relay data passed\n',
  );

  const { certificate, port } = await verifyTurnTls(environment);
  runTurnClient(envFile, credentials, 'tls', true);
  process.stdout.write('Smoke: authenticated TURN TLS passed\n');
  await verifyTurnTlsFailures(environment, certificate, port);

  const finalCharacter = credentials.credential.at(-1);
  const invalidCredentials = {
    ...credentials,
    credential: `${credentials.credential.slice(0, -1)}${finalCharacter === 'A' ? 'B' : 'A'}`,
  };
  runTurnClient(envFile, invalidCredentials, 'udp', false);
  process.stdout.write('Smoke: TURN rejected invalid credentials\n');

  const sharedSecret = await readTurnSharedSecret(environment);
  const expiredCredentials = createExpiredTurnCredentials(
    credentials,
    sharedSecret,
  );
  runTurnClient(envFile, expiredCredentials, 'udp', false);
  process.stdout.write('Smoke: TURN rejected expired credentials\n');
}

function reloadIntegrationProxy(envFile) {
  const composeCommand = integrationComposeArguments(
    envFile,
    'exec',
    '-T',
    'caddy',
    'caddy',
    'reload',
    '--config',
    '/etc/caddy/Caddyfile',
    '--adapter',
    'caddyfile',
  );
  const result = spawnSync('docker', composeCommand, {
    cwd: deployDirectory,
    encoding: 'utf8',
    env: composeProcessEnvironment(composeCommand),
    timeout: 30_000,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0
  ) {
    throw new Error('Integration proxy reload did not complete');
  }
}

export async function runSmoke() {
  const envFile = resolve(
    argumentValue('--env-file', resolve(deployDirectory, '.env')),
  );
  const environment = loadDeploymentEnvironment(envFile);
  const integration = hasArgument('--integration');
  const proxyReloadProof = hasArgument('--proxy-reload-proof');
  if (proxyReloadProof && !integration) {
    throw new Error(
      'Proxy reload proof is restricted to the integration profile',
    );
  }
  const authenticationRequests = smokeAuthenticationRequests(
    environment,
    integration,
  );
  const baseUrl = argumentValue(
    '--base-url',
    `https://${environment.APP_DOMAIN}`,
  );
  await waitUntilReady(baseUrl);

  const sessions = [];
  const clients = [];
  try {
    for (const request of authenticationRequests) {
      sessions.push(
        await postJson(
          baseUrl,
          request.path,
          request.body,
          undefined,
          request.expectedStatus,
        ),
      );
    }
    process.stdout.write('Smoke: authentication ready\n');

    for (const [index, session] of sessions.entries()) {
      const ticket = await issueTicket(baseUrl, session.accessToken);
      clients.push(await connect(baseUrl, ticket.ticket));
      if (proxyReloadProof && index === 0) {
        reloadIntegrationProxy(envFile);
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, proxyReloadIdleMilliseconds),
        );
        if (clients[0]?.socket.readyState !== WebSocket.OPEN) {
          throw new Error('Active WSS closed during proxy reload');
        }
      }
    }
    const [creator, joiner, third] = clients;

    const created = await successfulRequest(creator, 'room.create', {});
    if (proxyReloadProof) {
      process.stdout.write(
        'Smoke: active and new WSS passed proxy reload and idle timeout window\n',
      );
    }
    if (hasArgument('--turn-proof')) {
      await verifyTurnProof(envFile, environment, created);
    }
    const joined = await successfulRequest(joiner, 'room.join', {
      roomCode: created.roomCode,
    });
    await creator.next(isBroadcast('peer.joined'), 'peer.joined');
    await rejectedRequest(
      third,
      'room.join',
      { roomCode: created.roomCode },
      'ROOM_CODE_INVALID',
    );

    await successfulRequest(creator, 'peer.ready', {
      roomId: created.roomId,
      connectionEpoch: created.connectionEpoch,
      mediaPlan: smokeP2pMediaPlan,
    });
    await joiner.next(isBroadcast('peer.ready'), 'creator peer.ready');
    await successfulRequest(joiner, 'peer.ready', {
      roomId: created.roomId,
      connectionEpoch: joined.connectionEpoch,
      mediaPlan: smokeP2pMediaPlan,
    });
    await creator.next(isBroadcast('peer.ready'), 'joiner peer.ready');

    const negotiationId = randomUUID();
    await successfulRequest(creator, 'webrtc.offer', {
      roomId: created.roomId,
      connectionEpoch: created.connectionEpoch,
      negotiationId,
      description: { type: 'offer', sdp: 'v=0\r\n' },
    });
    await joiner.next(isBroadcast('webrtc.offer'), 'webrtc.offer');
    await successfulRequest(joiner, 'webrtc.answer', {
      roomId: created.roomId,
      connectionEpoch: joined.connectionEpoch,
      negotiationId,
      description: { type: 'answer', sdp: 'v=0\r\n' },
    });
    await creator.next(isBroadcast('webrtc.answer'), 'webrtc.answer');
    await successfulRequest(creator, 'webrtc.answerApplied', {
      roomId: created.roomId,
      connectionEpoch: created.connectionEpoch,
      negotiationId,
    });
    await successfulRequest(creator, 'webrtc.iceCandidate', {
      roomId: created.roomId,
      connectionEpoch: created.connectionEpoch,
      negotiationId,
      candidate: null,
    });
    await joiner.next(
      isBroadcast('webrtc.iceCandidate'),
      'webrtc.iceCandidate',
    );

    const acquired = await successfulRequest(creator, 'screen.acquire', {
      roomId: created.roomId,
    });
    await successfulRequest(creator, 'screen.release', {
      roomId: created.roomId,
      leaseId: acquired.lease.leaseId,
    });
    await successfulRequest(creator, 'room.end', {
      roomId: created.roomId,
    });
    await joiner.next(isBroadcast('room.closed'), 'room.closed');
    process.stdout.write(
      'Smoke: two-person signaling and screen lease passed\n',
    );
  } finally {
    for (const client of clients) {
      client.close();
    }
    for (const session of sessions) {
      try {
        await postJson(baseUrl, '/v1/auth/logout', {
          refreshToken: session.refreshToken,
        });
        const response = await fetch(new URL('/v1/auth/refresh', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
        if (response.status !== 401) {
          process.stderr.write('Smoke cleanup failed (refresh not revoked)\n');
          process.exitCode = 1;
        }
      } catch (error) {
        process.stderr.write(
          `Smoke cleanup failed (${error.name ?? 'Error'})\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  !maybeRestartWithCa()
) {
  runSmoke().catch((error) => {
    process.stderr.write(`Smoke failed (${error.message})\n`);
    process.exitCode = 1;
  });
}
