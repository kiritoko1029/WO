import { X509Certificate } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
  firewallRuleEvidenceForNetworkFault,
  matchesFirewallNetworkFaultRuleEvidence,
} from './firewall-policy.mjs';
import { evaluateP2pGate } from './p2p-gate-policy.mjs';
import {
  AcceptanceProtocolError,
  createAcceptanceSession,
  parseAcceptanceEnvelope,
} from './protocol.mjs';

const CONTROLLER_ARGUMENTS = Object.freeze([
  'duration',
  'publisher-agent',
  'receiver-agent',
  'server-url',
  'path',
  'source',
  'ca-file',
  'token-file',
  'run-dir',
]);
const ARGUMENT_SET = new Set(CONTROLLER_ARGUMENTS);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SENSITIVE_LOG_KEY =
  /(?:authorization|bearer|token|password|credential|secret|cert|key|message)/iu;
const SENSITIVE_EVIDENCE_KEY =
  /(?:^|_)(?:accessToken|refreshToken|token|password|credential|email|roomCode|sourceName|sourceTitle|windowTitle|ip|address)(?:$|_)/iu;
const SENSITIVE_EVIDENCE_VALUE =
  /(?:\b(?:access|refresh)?[_-]?token\b|\bpassword\b|\bcredential\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ControllerError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'ControllerError';
    this.code = code;
    this.detail = detail;
  }
}

function plainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) throw new ControllerError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new ControllerError(code, { actual, expected: wanted });
  }
}

function parseArguments(argv) {
  const result = Object.create(null);
  for (const argument of argv) {
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new ControllerError('CLI_FORMAT');
    }
    const separator = argument.indexOf('=');
    if (separator < 3) throw new ControllerError('CLI_FORMAT');
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!ARGUMENT_SET.has(name)) {
      throw new ControllerError('CLI_UNKNOWN', { name });
    }
    if (Object.hasOwn(result, name)) {
      throw new ControllerError('CLI_DUPLICATE', { name });
    }
    if (value.length === 0) throw new ControllerError('CLI_FORMAT', { name });
    result[name] = value;
  }
  for (const required of CONTROLLER_ARGUMENTS) {
    if (!Object.hasOwn(result, required)) {
      throw new ControllerError('CLI_REQUIRED', { name: required });
    }
  }
  return result;
}

function parseHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ControllerError('CLI_INVALID', { name });
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    url.pathname !== '/'
  ) {
    throw new ControllerError('CLI_INVALID', { name });
  }
  return url;
}

function absoluteFile(value, name) {
  const absolute = resolve(value);
  if (absolute !== value) throw new ControllerError('CLI_INVALID', { name });
  return absolute;
}

export function parseControllerCli(argv) {
  const values = parseArguments(argv);
  if (!/^\d{1,4}$/u.test(values.duration)) {
    throw new ControllerError('CLI_INVALID', { name: 'duration' });
  }
  const durationSeconds = Number(values.duration);
  if (durationSeconds < 1 || durationSeconds > 3_600) {
    throw new ControllerError('CLI_INVALID', { name: 'duration' });
  }
  if (!['direct', 'relay'].includes(values.path)) {
    throw new ControllerError('CLI_INVALID', { name: 'path' });
  }
  if (!['window', 'monitor'].includes(values.source)) {
    throw new ControllerError('CLI_INVALID', { name: 'source' });
  }
  const publisherAgent = parseHttpsUrl(
    values['publisher-agent'],
    'publisher-agent',
  );
  const receiverAgent = parseHttpsUrl(
    values['receiver-agent'],
    'receiver-agent',
  );
  if (publisherAgent.href === receiverAgent.href) {
    throw new ControllerError('CLI_INVALID', { name: 'receiver-agent' });
  }
  return Object.freeze({
    durationMs: durationSeconds * 1_000,
    publisherAgent,
    receiverAgent,
    serverUrl: parseHttpsUrl(values['server-url'], 'server-url'),
    path: values.path,
    source: values.source,
    caFile: absoluteFile(values['ca-file'], 'ca-file'),
    tokenFile: absoluteFile(values['token-file'], 'token-file'),
    runDir: resolve(values['run-dir']),
  });
}

async function readRestrictedText(path, options = {}) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new ControllerError(options.code ?? 'CREDENTIAL_FILE_INVALID');
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > (options.maximumBytes ?? 64 * 1024)
  ) {
    throw new ControllerError(options.code ?? 'CREDENTIAL_FILE_INVALID');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new ControllerError('CREDENTIAL_FILE_PERMISSIONS');
  }
  return readFile(path, 'utf8');
}

export async function loadControllerCredentials(config) {
  const [caText, tokenText] = await Promise.all([
    readRestrictedText(config.caFile, {
      code: 'INVALID_CA',
      maximumBytes: 1024 * 1024,
    }),
    readRestrictedText(config.tokenFile, {
      code: 'INVALID_TOKEN_FILE',
      maximumBytes: 4_096,
    }),
  ]);
  try {
    new X509Certificate(caText);
  } catch {
    throw new ControllerError('INVALID_CA');
  }
  const token = tokenText.trim();
  if (
    token.length < 16 ||
    token.length > 512 ||
    /[\r\n]/u.test(token) ||
    tokenText.trim().split(/\s/u).length !== 1
  ) {
    throw new ControllerError('INVALID_TOKEN_FILE');
  }
  return Object.freeze({ ca: caText, token });
}

function sanitizeLogDetails(details, secrets) {
  if (!plainObject(details)) return {};
  const output = {};
  for (const key of ['runId', 'agent', 'code', 'status']) {
    const value = details[key];
    if (
      SENSITIVE_LOG_KEY.test(key) ||
      !['string', 'number', 'boolean'].includes(typeof value)
    ) {
      continue;
    }
    const text = String(value);
    if (secrets.some((secret) => secret.length > 0 && text.includes(secret))) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function createSafeLogger(write = console.log, secrets = []) {
  const protectedValues = secrets.filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  return (event, details = {}) => {
    const safeEvent = /^[a-z][a-z0-9_]{0,63}$/u.test(event)
      ? event
      : 'invalid_event';
    write(
      JSON.stringify({
        event: safeEvent,
        ...sanitizeLogDetails(details, protectedValues),
      }),
    );
  };
}

function requestJson({ baseUrl, ca, token, requestImpl }, request) {
  const target = new URL(request.path, baseUrl);
  const body = request.body === undefined ? null : JSON.stringify(request.body);
  return new Promise((resolvePromise, rejectPromise) => {
    const outgoing = requestImpl(
      target,
      {
        method: request.method,
        ca,
        rejectUnauthorized: true,
        servername: baseUrl.hostname,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            outgoing.destroy(new ControllerError('RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          let value;
          try {
            value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            rejectPromise(new ControllerError('INVALID_AGENT_RESPONSE'));
            return;
          }
          if (
            (response.statusCode ?? 500) < 200 ||
            response.statusCode >= 300
          ) {
            const code =
              plainObject(value) && SAFE_CODE_PATTERN.test(value.code ?? '')
                ? value.code
                : 'AGENT_REQUEST_FAILED';
            rejectPromise(new ControllerError(code));
            return;
          }
          resolvePromise(value);
        });
      },
    );
    outgoing.on('error', (error) => {
      if (error instanceof ControllerError) rejectPromise(error);
      else rejectPromise(new ControllerError('AGENT_CONNECTION_FAILED'));
    });
    outgoing.setTimeout(request.timeoutMs ?? 15_000, () => {
      outgoing.destroy(new ControllerError('STEP_TIMEOUT'));
    });
    if (body !== null) outgoing.write(body);
    outgoing.end();
  });
}

export function probeServerReady(serverUrl, ca, requestImpl = httpsRequest) {
  const target = new URL('/v1/health/ready', serverUrl);
  return new Promise((resolvePromise) => {
    const outgoing = requestImpl(
      target,
      {
        method: 'GET',
        ca,
        rejectUnauthorized: true,
        servername: serverUrl.hostname,
        headers: { accept: 'application/json' },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            outgoing.destroy();
            resolvePromise(false);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            resolvePromise(false);
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolvePromise(
              plainObject(body) &&
                Object.keys(body).length === 1 &&
                body.status === 'ready',
            );
          } catch {
            resolvePromise(false);
          }
        });
      },
    );
    outgoing.on('error', () => resolvePromise(false));
    outgoing.setTimeout(10_000, () => {
      outgoing.destroy();
      resolvePromise(false);
    });
    outgoing.end();
  });
}

function validateEventResponse(response) {
  if (!plainObject(response) || !Array.isArray(response.events)) {
    throw new ControllerError('INVALID_AGENT_RESPONSE');
  }
  return response.events;
}

function createCommandEnvelope(
  runId,
  type,
  payload,
  sequence,
  now,
  monotonicNow,
) {
  return {
    version: 1,
    type,
    runId,
    sequence,
    wallClockMs: now(),
    monotonicMs: monotonicNow(),
    payload,
  };
}

export function createHttpsAgentClient(options) {
  const requestImpl = options.requestImpl ?? httpsRequest;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolvePromise) =>
        setTimeout(resolvePromise, milliseconds),
      ));
  let runId = null;
  let commandSequence = 0;
  let commandFlight = Promise.resolve();
  let lastCommandMonotonicMs = -1;
  let acceptedSequence = 0;
  let session = null;
  let failureCode = null;
  const samples = [];
  const bitrateEvents = [];
  let manifest = null;
  let cleanup = null;

  const send = (request) =>
    requestJson(
      {
        baseUrl: options.baseUrl,
        ca: options.ca,
        token: options.token,
        requestImpl,
      },
      request,
    );

  const acceptEvents = (events) => {
    for (const raw of events) {
      const parsed = parseAcceptanceEnvelope(raw);
      session.accept(parsed, options.token);
      acceptedSequence = parsed.sequence;
      if (parsed.type === 'run.sample') {
        if (parsed.payload.metrics?.recordType === 'bitrate') {
          bitrateEvents.push(parsed.payload.metrics.event);
        } else {
          samples.push(parsed.payload.metrics);
        }
      } else if (parsed.type === 'artifact.manifest') {
        manifest = parsed.payload;
      } else if (parsed.type === 'cleanup.ack') {
        cleanup = parsed.payload;
      } else if (parsed.type === 'run.failure') {
        failureCode = SAFE_CODE_PATTERN.test(parsed.payload.code)
          ? parsed.payload.code
          : 'AGENT_FAILED';
      }
    }
    if (failureCode !== null) throw new ControllerError(failureCode);
  };

  const poll = async (timeoutMs = 5_000) => {
    const response = await send({
      method: 'GET',
      path: `/v1/events?runId=${encodeURIComponent(runId)}&after=${acceptedSequence}`,
      timeoutMs,
    });
    acceptEvents(validateEventResponse(response));
  };

  const issueCommand = (type, payload, context) => {
    const flight = commandFlight.then(async () => {
      commandSequence += 1;
      lastCommandMonotonicMs = Math.max(
        monotonicNow(),
        lastCommandMonotonicMs + 0.001,
      );
      const message = createCommandEnvelope(
        runId,
        type,
        payload,
        commandSequence,
        now,
        () => lastCommandMonotonicMs,
      );
      const response = await send({
        method: 'POST',
        path: '/v1/command',
        body: {
          message,
          after: acceptedSequence,
          ...(context === undefined ? {} : { context }),
        },
        timeoutMs:
          type === 'run.stop' || type === 'run.cancel' ? 60_000 : 30_000,
      });
      acceptEvents(validateEventResponse(response));
      return response;
    });
    commandFlight = flight.catch(() => undefined);
    return flight;
  };

  const networkFaultResult = (response, profile, active) => {
    const value = response?.networkFault;
    exactKeys(
      value,
      [
        'profile',
        'scope',
        'active',
        'changed',
        'enabledRuleIds',
        'disabledRuleIds',
      ],
      'INVALID_AGENT_RESPONSE',
    );
    let ruleEvidence;
    let rulesMatch;
    try {
      firewallRuleEvidenceForNetworkFault(profile);
      const expectedProfile = active ? profile : null;
      ruleEvidence = firewallRuleEvidenceForNetworkFault(expectedProfile);
      rulesMatch = matchesFirewallNetworkFaultRuleEvidence(
        value,
        expectedProfile,
      );
    } catch {
      throw new ControllerError('INVALID_AGENT_RESPONSE');
    }
    if (
      value.profile !== profile ||
      value.scope !== 'client-egress' ||
      value.active !== active ||
      typeof value.changed !== 'boolean' ||
      !rulesMatch
    ) {
      throw new ControllerError('INVALID_AGENT_RESPONSE');
    }
    return Object.freeze({
      profile: value.profile,
      scope: value.scope,
      active: value.active,
      changed: value.changed,
      enabledRuleIds: ruleEvidence.enabledRuleIds,
      disabledRuleIds: ruleEvidence.disabledRuleIds,
    });
  };

  return Object.freeze({
    async connect(nextRunId) {
      runId = nextRunId;
      session = createAcceptanceSession({
        runId,
        token: options.token,
        now,
      });
      const response = await send({
        method: 'POST',
        path: '/v1/register',
        body: { runId },
      });
      exactKeys(
        response,
        ['events', 'packageSha256'],
        'INVALID_AGENT_RESPONSE',
      );
      if (!HASH_PATTERN.test(response.packageSha256)) {
        throw new ControllerError('INVALID_AGENT_RESPONSE');
      }
      acceptEvents(validateEventResponse(response));
      const [registration, capabilities] = response.events;
      if (
        registration?.type !== 'agent.register' ||
        capabilities?.type !== 'capability.report'
      ) {
        throw new ControllerError('INVALID_AGENT_RESPONSE');
      }
      return Object.freeze({
        ...registration.payload,
        packageSha256: response.packageSha256,
        capabilities: capabilities.payload,
      });
    },
    async prepare(input) {
      const response = await issueCommand(
        'run.prepare',
        {
          packageSha256: input.packageSha256,
          source: input.source,
          path: input.path,
        },
        { role: input.role, serverUrl: input.serverUrl },
      );
      if (
        response.packageSha256 !== input.packageSha256 ||
        response.signatureVerified !== true
      ) {
        throw new ControllerError('PACKAGE_VERIFICATION_FAILED');
      }
      return Object.freeze({
        packageSha256: response.packageSha256,
        signatureVerified: true,
      });
    },
    async start(durationMs) {
      await issueCommand('run.start', { durationMs });
    },
    async applyNetworkFault(profile) {
      const response = await issueCommand('network.fault.apply', { profile });
      return networkFaultResult(response, profile, true);
    },
    async clearNetworkFault(profile) {
      const response = await issueCommand('network.fault.clear', { profile });
      return networkFaultResult(response, profile, false);
    },
    async collect({ durationMs, signal }) {
      const deadline = now() + durationMs;
      while (now() < deadline) {
        if (signal?.aborted) throw new ControllerError('RUN_CANCELED');
        await sleep(Math.min(1_000, deadline - now()));
        if (signal?.aborted) throw new ControllerError('RUN_CANCELED');
        await poll(Math.min(5_000, Math.max(1_000, deadline - now() + 500)));
        session.assertHeartbeat();
      }
      await poll(5_000);
      return Object.freeze({
        samples: [...samples],
        bitrateEvents: [...bitrateEvents],
      });
    },
    async stop() {
      await issueCommand('run.stop', {});
      if (manifest === null || cleanup === null) {
        await poll(30_000);
      }
      return Object.freeze({ manifest, cleanup });
    },
    async cancel(reason) {
      if (cleanup !== null) return cleanup;
      try {
        await issueCommand('run.cancel', { reason: reason.slice(0, 128) });
      } catch (error) {
        if (cleanup === null) throw error;
      }
      if (cleanup === null) await poll(30_000);
      return cleanup;
    },
  });
}

function capabilityCheck(metadata, source, path) {
  if (
    !metadata.capabilities.screenSources.includes(source) ||
    metadata.capabilities.canVerifySignature !== true ||
    (path === 'relay' && metadata.capabilities.canInstallFirewall !== true)
  ) {
    throw new ControllerError('CAPABILITY_MISSING');
  }
}

function cleanupComplete(value) {
  return value?.restoredFirewall === true && value?.childrenStopped === true;
}

function manifestHashes(manifest, expectedPackageHash) {
  if (!plainObject(manifest) || !Array.isArray(manifest.files)) return null;
  const files = new Map();
  for (const file of manifest.files) {
    if (
      !plainObject(file) ||
      typeof file.name !== 'string' ||
      !HASH_PATTERN.test(file.sha256) ||
      files.has(file.name)
    ) {
      return null;
    }
    files.set(file.name, file.sha256);
  }
  if (
    files.get('package') !== expectedPackageHash ||
    !HASH_PATTERN.test(files.get('executable') ?? '') ||
    !HASH_PATTERN.test(files.get('app.asar') ?? '')
  ) {
    return null;
  }
  return Object.freeze({
    signatureVerified: true,
    packageSha256: files.get('package'),
    executableSha256: files.get('executable'),
    asarSha256: files.get('app.asar'),
    files: manifest.files,
  });
}

function evidenceIsSafe(value, secrets) {
  const visit = (candidate) => {
    if (typeof candidate === 'string') {
      return (
        !SENSITIVE_EVIDENCE_VALUE.test(candidate) &&
        secrets.every(
          (secret) => secret.length === 0 || !candidate.includes(secret),
        )
      );
    }
    if (candidate === null || typeof candidate !== 'object') return true;
    return Object.entries(candidate).every(
      ([key, child]) => !SENSITIVE_EVIDENCE_KEY.test(key) && visit(child),
    );
  };
  return visit(value);
}

function errorCode(error) {
  if (
    (error instanceof ControllerError ||
      error instanceof AcceptanceProtocolError) &&
    SAFE_CODE_PATTERN.test(error.code)
  ) {
    return error.code;
  }
  return 'INTERNAL_ERROR';
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function baseSummary(runId, config) {
  return {
    runId,
    status: 'GATE_FAILED',
    hardwarePass: false,
    durationMs: config.durationMs,
    path: config.path,
    source: config.source,
    failure: null,
    cleanup: { publisher: false, receiver: false },
  };
}

async function cancelBoth(clients, attempted, reason) {
  const results = await Promise.allSettled(
    clients.map((client, index) =>
      attempted[index] ? client.cancel(reason) : Promise.resolve(null),
    ),
  );
  return results.map(
    (result, index) =>
      !attempted[index] ||
      (result.status === 'fulfilled' && cleanupComplete(result.value)),
  );
}

export async function runController(config, dependencies = {}) {
  const runId = config.runId ?? config.runDir.split(/[\\/]/u).at(-1);
  if (!RUN_ID_PATTERN.test(runId ?? '')) {
    throw new ControllerError('INVALID_RUN_ID');
  }
  await mkdir(config.runDir, { recursive: false, mode: 0o700 });
  const logger = dependencies.logger ?? (() => {});
  const evaluator = dependencies.evaluateGate ?? evaluateP2pGate;
  const clients =
    dependencies.clients ??
    [config.publisherAgent, config.receiverAgent].map((baseUrl) =>
      createHttpsAgentClient({
        baseUrl,
        ca: config.ca,
        token: config.token,
      }),
    );
  if (clients.length !== 2) throw new ControllerError('INVALID_CLIENTS');
  const summary = baseSummary(runId, config);
  const abortController = new AbortController();
  const agentRunsAttempted = [false, false];
  let collectionFlights = [];

  try {
    logger('run_started', { runId });
    const probe = dependencies.probeServer ?? probeServerReady;
    let serverReady = false;
    try {
      serverReady = (await probe(config.serverUrl, config.ca)) === true;
    } catch {
      serverReady = false;
    }
    if (!serverReady) throw new ControllerError('SERVER_UNAVAILABLE');
    const metadata = await Promise.all(
      clients.map((client, index) => {
        agentRunsAttempted[index] = true;
        return client.connect(runId);
      }),
    );
    capabilityCheck(metadata[0], config.source, config.path);
    capabilityCheck(metadata[1], config.source, config.path);
    if (
      metadata[0].agentId === metadata[1].agentId ||
      config.publisherAgent.hostname === config.receiverAgent.hostname
    ) {
      throw new ControllerError('PHYSICAL_DEVICE_PROOF_MISSING');
    }

    const preparations = await Promise.all(
      clients.map((client, index) =>
        client.prepare({
          packageSha256: metadata[index].packageSha256,
          source: config.source,
          path: config.path,
          role: index === 0 ? 'publisher' : 'receiver',
          serverUrl: config.serverUrl.href,
        }),
      ),
    );
    if (
      preparations.some(
        (preparation, index) =>
          preparation.signatureVerified !== true ||
          preparation.packageSha256 !== metadata[index].packageSha256,
      )
    ) {
      throw new ControllerError('PACKAGE_VERIFICATION_FAILED');
    }

    await Promise.all(clients.map((client) => client.start(config.durationMs)));
    collectionFlights = clients.map((client) =>
      client.collect({
        durationMs: config.durationMs,
        signal: abortController.signal,
      }),
    );
    const collections = await Promise.all(collectionFlights);
    const stopped = await Promise.all(clients.map((client) => client.stop()));
    summary.cleanup.publisher = cleanupComplete(stopped[0].cleanup);
    summary.cleanup.receiver = cleanupComplete(stopped[1].cleanup);
    if (!summary.cleanup.publisher || !summary.cleanup.receiver) {
      throw new ControllerError('CLEANUP_INCOMPLETE');
    }

    const manifests = stopped.map((result, index) =>
      manifestHashes(result.manifest, metadata[index].packageSha256),
    );
    if (manifests.some((manifest) => manifest === null)) {
      throw new ControllerError('ARTIFACT_MANIFEST_INCOMPLETE');
    }
    const evidence = {
      publisherSamples: collections[0].samples,
      receiverSamples: collections[1].samples,
      bitrateEvents: collections[0].bitrateEvents,
      publisherManifest: manifests[0],
      receiverManifest: manifests[1],
    };
    if (!evidenceIsSafe(evidence, [config.token ?? ''])) {
      throw new ControllerError('EVIDENCE_NOT_REDACTED');
    }
    await Promise.all([
      writeJson(
        resolve(config.runDir, 'publisher-samples.json'),
        evidence.publisherSamples,
      ),
      writeJson(
        resolve(config.runDir, 'receiver-samples.json'),
        evidence.receiverSamples,
      ),
      writeJson(
        resolve(config.runDir, 'bitrate-events.json'),
        evidence.bitrateEvents,
      ),
      writeJson(resolve(config.runDir, 'artifact-manifests.json'), {
        publisher: manifests[0],
        receiver: manifests[1],
      }),
    ]);
    const gate = evaluator({
      durationMs: config.durationMs,
      separatePhysicalDevices: true,
      path: config.path,
      publisherSamples: evidence.publisherSamples,
      receiverSamples: evidence.receiverSamples,
      bitrateEvents: evidence.bitrateEvents,
      artifactManifest: manifests[0],
    });
    if (!plainObject(gate) || typeof gate.hardwarePass !== 'boolean') {
      throw new ControllerError('INVALID_GATE_RESULT');
    }
    summary.status =
      gate.hardwarePass === true ? 'HARDWARE_PASS' : 'GATE_FAILED';
    summary.hardwarePass = gate.hardwarePass === true;
    summary.checks = gate.checks;
    summary.agents = metadata.map(({ agentId, platform, architecture }) => ({
      agentId,
      platform,
      architecture,
    }));
  } catch (error) {
    abortController.abort();
    await Promise.allSettled(collectionFlights);
    const code = errorCode(error);
    const cleanupResults = await cancelBoth(clients, agentRunsAttempted, code);
    summary.cleanup.publisher = cleanupResults[0] === true;
    summary.cleanup.receiver = cleanupResults[1] === true;
    summary.failure = {
      code:
        summary.cleanup.publisher && summary.cleanup.receiver
          ? code
          : 'CLEANUP_INCOMPLETE',
    };
    summary.status = 'GATE_FAILED';
    summary.hardwarePass = false;
    logger('run_failed', { runId, code: summary.failure.code });
  }
  await writeJson(resolve(config.runDir, 'summary.json'), summary);
  logger('run_finished', { runId, status: summary.status });
  return Object.freeze(summary);
}

export async function mainController(argv = process.argv.slice(2)) {
  const parsed = parseControllerCli(argv);
  const credentials = await loadControllerCredentials(parsed);
  const logger = createSafeLogger(console.log, [credentials.token]);
  const summary = await runController(
    { ...parsed, ...credentials },
    { logger },
  );
  process.exitCode = summary.hardwarePass ? 0 : 1;
}

const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  mainController().catch((error) => {
    const code = errorCode(error);
    console.error(JSON.stringify({ event: 'controller_failed', code }));
    process.exitCode = 1;
  });
}
