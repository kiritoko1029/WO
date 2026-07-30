import { timingSafeEqual } from 'node:crypto';

export const ACCEPTANCE_PROTOCOL_VERSION = 1;
export const ACCEPTANCE_NETWORK_FAULT_PROFILES = Object.freeze([
  'udp-all',
  'turn-3478',
  'turn-tls-5349',
  'turn-relay-range',
]);
export const ACCEPTANCE_MESSAGE_TYPES = Object.freeze([
  'agent.register',
  'capability.report',
  'run.prepare',
  'run.start',
  'network.fault.apply',
  'network.fault.clear',
  'run.sample',
  'run.stop',
  'artifact.manifest',
  'run.failure',
  'run.heartbeat',
  'run.cancel',
  'cleanup.ack',
]);

const TYPE_SET = new Set(ACCEPTANCE_MESSAGE_TYPES);
const NETWORK_FAULT_PROFILE_SET = new Set(ACCEPTANCE_NETWORK_FAULT_PROFILES);
const BASE_KEYS = Object.freeze([
  'version',
  'type',
  'runId',
  'sequence',
  'wallClockMs',
  'monotonicMs',
  'payload',
]);
const PAYLOAD_KEYS = Object.freeze({
  'agent.register': ['agentId', 'platform', 'architecture'],
  'capability.report': [
    'screenSources',
    'canInstallFirewall',
    'canVerifySignature',
  ],
  'run.prepare': ['packageSha256', 'source', 'path'],
  'run.start': ['durationMs'],
  'network.fault.apply': ['profile'],
  'network.fault.clear': ['profile'],
  'run.sample': ['metrics'],
  'run.stop': [],
  'artifact.manifest': ['files'],
  'run.failure': ['code', 'message'],
  'run.heartbeat': [],
  'run.cancel': ['reason'],
  'cleanup.ack': ['restoredFirewall', 'childrenStopped'],
});

export class AcceptanceProtocolError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'AcceptanceProtocolError';
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
  if (!plainObject(value)) throw new AcceptanceProtocolError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new AcceptanceProtocolError(code, { actual, expected: wanted });
  }
}

function identifier(value, name) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new AcceptanceProtocolError('INVALID_MESSAGE', { field: name });
  }
}

function validatePayload(type, payload) {
  exactKeys(payload, PAYLOAD_KEYS[type], 'INVALID_PAYLOAD');
  switch (type) {
    case 'agent.register':
      identifier(payload.agentId, 'agentId');
      if (!['win32', 'darwin'].includes(payload.platform)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      if (!['x64', 'arm64'].includes(payload.architecture)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'capability.report':
      if (
        !Array.isArray(payload.screenSources) ||
        payload.screenSources.some(
          (source) => source !== 'window' && source !== 'monitor',
        ) ||
        typeof payload.canInstallFirewall !== 'boolean' ||
        typeof payload.canVerifySignature !== 'boolean'
      ) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'run.prepare':
      if (!/^[a-f0-9]{64}$/u.test(payload.packageSha256)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      if (!['window', 'monitor'].includes(payload.source)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      if (!['direct', 'relay'].includes(payload.path)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'run.start':
      if (
        !Number.isSafeInteger(payload.durationMs) ||
        payload.durationMs < 1_000 ||
        payload.durationMs > 3_600_000
      ) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'network.fault.apply':
    case 'network.fault.clear':
      if (!NETWORK_FAULT_PROFILE_SET.has(payload.profile)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'run.sample':
      if (!plainObject(payload.metrics)) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'artifact.manifest':
      if (
        !Array.isArray(payload.files) ||
        payload.files.length < 3 ||
        payload.files.some(
          (file) =>
            !plainObject(file) ||
            Object.keys(file).sort().join(',') !== 'name,sha256' ||
            typeof file.name !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(file.sha256),
        )
      ) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'run.failure':
      identifier(payload.code, 'code');
      if (typeof payload.message !== 'string' || payload.message.length > 256) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'run.cancel':
      if (typeof payload.reason !== 'string' || payload.reason.length > 128) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    case 'cleanup.ack':
      if (
        typeof payload.restoredFirewall !== 'boolean' ||
        typeof payload.childrenStopped !== 'boolean'
      ) {
        throw new AcceptanceProtocolError('INVALID_PAYLOAD');
      }
      break;
    default:
      break;
  }
}

export function parseAcceptanceEnvelope(value) {
  exactKeys(value, BASE_KEYS, 'INVALID_MESSAGE');
  if (
    value.version !== ACCEPTANCE_PROTOCOL_VERSION ||
    !TYPE_SET.has(value.type)
  ) {
    throw new AcceptanceProtocolError('INVALID_MESSAGE');
  }
  identifier(value.runId, 'runId');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new AcceptanceProtocolError('INVALID_SEQUENCE');
  }
  if (!Number.isSafeInteger(value.wallClockMs) || value.wallClockMs < 0) {
    throw new AcceptanceProtocolError('INVALID_CLOCK');
  }
  if (!Number.isFinite(value.monotonicMs) || value.monotonicMs < 0) {
    throw new AcceptanceProtocolError('INVALID_CLOCK');
  }
  validatePayload(value.type, value.payload);
  return Object.freeze({
    ...value,
    payload: Object.freeze({ ...value.payload }),
  });
}

function validToken(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string')
    return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const presentedBytes = Buffer.from(presented, 'utf8');
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes)
  );
}

export function createAcceptanceSession(options) {
  identifier(options?.runId, 'runId');
  identifier(options?.token, 'token');
  const now = options.now ?? Date.now;
  const maxClockSkewMs = options.maxClockSkewMs ?? 5_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 5_000;
  let sequence = 0;
  let monotonicMs = -1;
  let lastHeartbeatAtMs = now();
  let stepDeadlineMs = null;
  let state = 'new';

  const requireState = (allowed, type) => {
    if (!allowed.includes(state)) {
      throw new AcceptanceProtocolError('INVALID_STATE', { state, type });
    }
  };

  const applyState = (message) => {
    switch (message.type) {
      case 'agent.register':
        requireState(['new'], message.type);
        state = 'registered';
        break;
      case 'capability.report':
        requireState(['registered'], message.type);
        state = 'capable';
        break;
      case 'run.prepare':
        requireState(['capable'], message.type);
        state = 'prepared';
        break;
      case 'run.start':
        requireState(['prepared'], message.type);
        state = 'running';
        lastHeartbeatAtMs = now();
        break;
      case 'run.sample':
      case 'run.heartbeat':
      case 'network.fault.apply':
      case 'network.fault.clear':
        requireState(['running'], message.type);
        if (message.type === 'run.heartbeat') lastHeartbeatAtMs = now();
        break;
      case 'run.stop':
        requireState(['running'], message.type);
        state = 'stopping';
        break;
      case 'artifact.manifest':
        requireState(['stopping'], message.type);
        state = 'stopped';
        break;
      case 'run.failure':
        requireState(
          ['registered', 'capable', 'prepared', 'running', 'stopping'],
          message.type,
        );
        state = 'failed';
        break;
      case 'run.cancel':
        requireState(
          ['registered', 'capable', 'prepared', 'running', 'stopping'],
          message.type,
        );
        state = 'canceling';
        break;
      case 'cleanup.ack':
        requireState(['failed', 'canceling', 'stopped'], message.type);
        if (
          !message.payload.restoredFirewall ||
          !message.payload.childrenStopped
        ) {
          throw new AcceptanceProtocolError('CLEANUP_INCOMPLETE');
        }
        state = 'cleaned';
        break;
      default:
        throw new AcceptanceProtocolError('INVALID_MESSAGE');
    }
  };

  return Object.freeze({
    accept(value, presentedToken) {
      if (!validToken(options.token, presentedToken)) {
        throw new AcceptanceProtocolError('AUTH_FAILED');
      }
      const message = parseAcceptanceEnvelope(value);
      if (message.runId !== options.runId) {
        throw new AcceptanceProtocolError('RUN_MISMATCH');
      }
      if (message.sequence !== sequence + 1) {
        throw new AcceptanceProtocolError('SEQUENCE_REPLAY');
      }
      if (message.monotonicMs <= monotonicMs) {
        throw new AcceptanceProtocolError('MONOTONIC_REPLAY');
      }
      const currentTime = now();
      if (Math.abs(message.wallClockMs - currentTime) > maxClockSkewMs) {
        throw new AcceptanceProtocolError('CLOCK_SKEW');
      }
      sequence = message.sequence;
      monotonicMs = message.monotonicMs;
      applyState(message);
      return message;
    },
    beginStep(timeoutMs) {
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 600_000
      ) {
        throw new AcceptanceProtocolError('INVALID_TIMEOUT');
      }
      stepDeadlineMs = now() + timeoutMs;
    },
    assertStepDeadline() {
      if (stepDeadlineMs !== null && now() > stepDeadlineMs) {
        throw new AcceptanceProtocolError('STEP_TIMEOUT');
      }
    },
    assertHeartbeat() {
      if (
        state === 'running' &&
        now() - lastHeartbeatAtMs > heartbeatTimeoutMs
      ) {
        throw new AcceptanceProtocolError('HEARTBEAT_LOST');
      }
    },
    getSnapshot: () =>
      Object.freeze({ state, sequence, monotonicMs, lastHeartbeatAtMs }),
  });
}
