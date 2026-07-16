import ipaddr from 'ipaddr.js';
import { z } from 'zod';

import {
  NODE_ENVIRONMENTS,
  ServerConfigError,
  addIssue,
  exactString,
  hasControlCharacter,
  isLoopbackOrWildcardHostname,
  parseInteger,
  parseUrl,
  toConfigIssues,
  type ConfigIssue,
  type NodeEnvironment,
} from './internal/validation.js';

export type P2pServerConfig = Readonly<{
  nodeEnv: NodeEnvironment;
  server: Readonly<{ host: string; port: number }>;
  publicUrl: string;
  database: Readonly<{ url: string }>;
  auth: Readonly<{ jwtAccessSecret: string }>;
  turn: Readonly<{
    sharedSecret: string;
    realm: string;
    host: string;
    urls: readonly string[];
    credentialTtlSeconds: number;
  }>;
  room: Readonly<{
    codeTtlSeconds: number;
    disconnectGraceSeconds: number;
  }>;
  screen: Readonly<{
    leaseTtlSeconds: number;
    bitrateRange: Readonly<{ min: number; max: number }>;
  }>;
}>;

const MAX_TTL_SECONDS = 86_400;
const MIN_PRODUCTION_TURN_CREDENTIAL_TTL_SECONDS = 300;
const MAX_TURN_URLS = 8;
const MAX_TURN_URL_LENGTH = 2_048;
const MAX_TURN_URLS_LENGTH =
  MAX_TURN_URLS * MAX_TURN_URL_LENGTH + (MAX_TURN_URLS - 1);
const MIN_GENERATED_SECRET_BYTES = 32;
const MIN_GENERATED_SECRET_DISTINCT_CHARACTERS = 12;
const MAX_REPEATING_SECRET_PERIOD = 16;

const rawEnvironmentSchema = z
  .object({
    NODE_ENV: exactString(11).pipe(
      z.enum(NODE_ENVIRONMENTS, {
        error: 'must be development, test, or production',
      }),
    ),
    SERVER_HOST: exactString(253),
    SERVER_PORT: exactString(5),
    PUBLIC_URL: exactString(2_048),
    DATABASE_URL: exactString(2_048),
    JWT_ACCESS_SECRET: exactString(4_096),
    TURN_SHARED_SECRET: exactString(4_096),
    TURN_REALM: exactString(253),
    TURN_HOST: exactString(253),
    TURN_URLS: exactString(MAX_TURN_URLS_LENGTH),
    TURN_CREDENTIAL_TTL_SECONDS: exactString(5),
    ROOM_CODE_TTL_SECONDS: exactString(5),
    ROOM_DISCONNECT_GRACE_SECONDS: exactString(5),
    SCREEN_LEASE_TTL_SECONDS: exactString(5),
    SCREEN_BITRATE_MIN: exactString(10),
    SCREEN_BITRATE_MAX: exactString(10),
  })
  .strict();

const requiredEnvironmentFields = Object.keys(
  rawEnvironmentSchema.shape,
) as (keyof z.infer<typeof rawEnvironmentSchema>)[];

const iceServerUriPattern =
  /^(stun|turn):(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?(?:\?([^#]*))?$/u;
const hostnameSchema = z.hostname();
const ipv4Schema = z.ipv4();
const ipv6Schema = z.ipv6();
const alternateNumericHostPattern = /^(?:(?:0x[0-9a-f]+|[0-9]+)(?:\.|$))+$/iu;
const invalidPercentEscapePattern = /%(?![0-9a-f]{2})/iu;
const postgresSchemeAndAuthorityPattern =
  /^(?:postgres|postgresql):\/\/[^/?#]*/iu;

const normalizeBareHost = (value: string): string | undefined => {
  if (value.includes('[') || value.includes(']')) {
    return undefined;
  }

  const lowercaseValue = value.toLowerCase();
  if (
    ipv4Schema.safeParse(lowercaseValue).success ||
    ipv6Schema.safeParse(lowercaseValue).success
  ) {
    return ipaddr.parse(lowercaseValue).toString();
  }

  if (alternateNumericHostPattern.test(lowercaseValue)) {
    return undefined;
  }

  const normalizedDns = lowercaseValue.endsWith('.')
    ? lowercaseValue.slice(0, -1)
    : lowercaseValue;
  if (
    normalizedDns.length === 0 ||
    normalizedDns.endsWith('.') ||
    !hostnameSchema.safeParse(normalizedDns).success
  ) {
    return undefined;
  }

  return normalizedDns;
};

const isValidNormalizedUrlHostname = (value: string): boolean => {
  const lowercaseValue = value.toLowerCase();
  if (lowercaseValue.startsWith('[') && lowercaseValue.endsWith(']')) {
    return ipv6Schema.safeParse(lowercaseValue.slice(1, -1)).success;
  }
  if (ipv4Schema.safeParse(lowercaseValue).success) {
    return true;
  }

  const normalizedDns = lowercaseValue.endsWith('.')
    ? lowercaseValue.slice(0, -1)
    : lowercaseValue;
  return (
    normalizedDns.length > 0 &&
    !normalizedDns.endsWith('.') &&
    hostnameSchema.safeParse(normalizedDns).success
  );
};

const validateRawP2pDatabaseUrl = (value: string, issues: ConfigIssue[]) => {
  const hasInvalidPercentEncoding = invalidPercentEscapePattern.test(value);
  if (hasInvalidPercentEncoding) {
    addIssue(
      issues,
      'DATABASE_URL',
      'must contain only valid percent-encoded URL sequences',
    );
  }
  if (value.includes('#')) {
    addIssue(issues, 'DATABASE_URL', 'must not contain a fragment');
  }

  const schemeAndAuthority = postgresSchemeAndAuthorityPattern.exec(value);
  if (schemeAndAuthority === null) {
    return;
  }

  const pathAndQuery = value.slice(schemeAndAuthority[0].length);
  const queryStart = pathAndQuery.indexOf('?');
  const rawPathname =
    queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  if (!/^\/[^/\\]+$/u.test(rawPathname)) {
    addIssue(
      issues,
      'DATABASE_URL',
      'must contain exactly one non-empty database path segment',
    );
    return;
  }

  let decodedSegment: string;
  try {
    decodedSegment = decodeURIComponent(rawPathname.slice(1));
  } catch {
    if (!hasInvalidPercentEncoding) {
      addIssue(
        issues,
        'DATABASE_URL',
        'must contain only valid percent-encoded URL sequences',
      );
    }
    return;
  }

  if (
    decodedSegment.length === 0 ||
    decodedSegment === '.' ||
    decodedSegment === '..' ||
    decodedSegment.includes('/') ||
    decodedSegment.includes('\\')
  ) {
    addIssue(
      issues,
      'DATABASE_URL',
      'database path segment must not decode to dot segments or path separators',
    );
  }
};

const parseP2pDatabaseUrl = (value: string, issues: ConfigIssue[]): string => {
  validateRawP2pDatabaseUrl(value, issues);
  return parseUrl('DATABASE_URL', value, ['postgres:', 'postgresql:'], issues);
};

const hasShortRepeatingPeriod = (value: string): boolean => {
  const maximumPeriod = Math.min(
    MAX_REPEATING_SECRET_PERIOD,
    Math.floor(value.length / 2),
  );
  for (let period = 1; period <= maximumPeriod; period += 1) {
    let repeats = true;
    for (let index = period; index < value.length; index += 1) {
      if (value[index] !== value[index % period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) {
      return true;
    }
  }
  return false;
};

const validateProductionGeneratedSecret = (
  field: string,
  value: string,
  issues: ConfigIssue[],
) => {
  const decoded = Buffer.from(value, 'base64url');
  const isCanonicalBase64Url =
    /^[A-Za-z0-9_-]+$/u.test(value) && decoded.toString('base64url') === value;
  const hasEnoughDistinctCharacters =
    new Set(value).size >= MIN_GENERATED_SECRET_DISTINCT_CHARACTERS;

  if (
    !isCanonicalBase64Url ||
    decoded.byteLength < MIN_GENERATED_SECRET_BYTES ||
    !hasEnoughDistinctCharacters ||
    hasShortRepeatingPeriod(value)
  ) {
    addIssue(
      issues,
      field,
      `must be generated as canonical unpadded base64url from at least ${MIN_GENERATED_SECRET_BYTES} random bytes in production`,
    );
  }
};

type ParsedIceServerUrl = Readonly<{
  scheme: 'stun' | 'turn';
  hostname: string;
  duplicateKey: string;
}>;

const parseIceServerUrl = (value: string): ParsedIceServerUrl | undefined => {
  if (
    value.length === 0 ||
    value.length > MAX_TURN_URL_LENGTH ||
    hasControlCharacter(value)
  ) {
    return undefined;
  }

  const match = iceServerUriPattern.exec(value);
  if (match === null) {
    return undefined;
  }

  const [, scheme, host, port, query] = match;
  if ((scheme !== 'stun' && scheme !== 'turn') || host === undefined) {
    return undefined;
  }

  const unwrappedHost = host.startsWith('[') ? host.slice(1, -1) : host;
  const normalizedHost = host.startsWith('[')
    ? ipv6Schema.safeParse(unwrappedHost).success
      ? ipaddr.parse(unwrappedHost).toString()
      : undefined
    : normalizeBareHost(unwrappedHost);
  if (normalizedHost === undefined) {
    return undefined;
  }

  let portNumber = 3_478;
  if (port !== undefined) {
    if (port.length > 1 && port.startsWith('0')) {
      return undefined;
    }
    portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65_535) {
      return undefined;
    }
  }

  const queryIsValid =
    scheme === 'stun'
      ? query === undefined
      : query === undefined ||
        query === 'transport=udp' ||
        query === 'transport=tcp';
  if (!queryIsValid) {
    return undefined;
  }

  const transport =
    scheme === 'turn' ? (query === 'transport=tcp' ? 'tcp' : 'udp') : undefined;
  const duplicateKey = JSON.stringify([
    scheme,
    normalizedHost,
    portNumber,
    transport,
  ]);

  return { scheme, hostname: normalizedHost, duplicateKey };
};

const parseTurnUrls = (
  value: string,
  expectedHost: string | undefined,
  issues: ConfigIssue[],
): string[] => {
  const urls = value.split(',');
  if (urls.length > MAX_TURN_URLS) {
    addIssue(issues, 'TURN_URLS', `must contain at most ${MAX_TURN_URLS} URLs`);
    return [];
  }

  const seenUrls = new Set<string>();
  let hasTurnUrl = false;
  for (const url of urls) {
    const parsed = parseIceServerUrl(url);
    if (parsed === undefined) {
      addIssue(
        issues,
        'TURN_URLS',
        'must contain only valid canonical stun: or turn: URLs',
      );
      continue;
    }
    if (parsed.scheme === 'turn') {
      hasTurnUrl = true;
    }
    if (expectedHost !== undefined && parsed.hostname !== expectedHost) {
      addIssue(issues, 'TURN_URLS', 'every URL hostname must equal TURN_HOST');
    }
    if (seenUrls.has(parsed.duplicateKey)) {
      addIssue(issues, 'TURN_URLS', 'must not contain duplicate URLs');
    } else {
      seenUrls.add(parsed.duplicateKey);
    }
  }
  if (!hasTurnUrl) {
    addIssue(issues, 'TURN_URLS', 'must contain at least one turn: URL');
  }

  return urls;
};

const freezeConfig = (config: P2pServerConfig): P2pServerConfig => {
  Object.freeze(config.server);
  Object.freeze(config.database);
  Object.freeze(config.auth);
  Object.freeze(config.turn.urls);
  Object.freeze(config.turn);
  Object.freeze(config.room);
  Object.freeze(config.screen.bitrateRange);
  Object.freeze(config.screen);
  return Object.freeze(config);
};

export const parseP2pServerConfig = (
  env: Record<string, string | undefined>,
): P2pServerConfig => {
  const selectedEnvironment = Object.fromEntries(
    requiredEnvironmentFields.map((field) => [field, env[field]]),
  );
  const rawResult = rawEnvironmentSchema.safeParse(selectedEnvironment);

  if (!rawResult.success) {
    throw new ServerConfigError(toConfigIssues(rawResult.error));
  }

  const raw = rawResult.data;
  const issues: ConfigIssue[] = [];
  const serverPort = parseInteger(
    'SERVER_PORT',
    raw.SERVER_PORT,
    1,
    65_535,
    issues,
  );
  const publicUrl = parseUrl(
    'PUBLIC_URL',
    raw.PUBLIC_URL,
    ['http:', 'https:'],
    issues,
    true,
  );
  const databaseUrl = parseP2pDatabaseUrl(raw.DATABASE_URL, issues);
  const turnHost = normalizeBareHost(raw.TURN_HOST);
  if (turnHost === undefined) {
    addIssue(
      issues,
      'TURN_HOST',
      'must be a bare hostname or IP address without brackets',
    );
  }
  const turnUrls = parseTurnUrls(raw.TURN_URLS, turnHost, issues);
  const turnCredentialTtlSeconds = parseInteger(
    'TURN_CREDENTIAL_TTL_SECONDS',
    raw.TURN_CREDENTIAL_TTL_SECONDS,
    raw.NODE_ENV === 'production'
      ? MIN_PRODUCTION_TURN_CREDENTIAL_TTL_SECONDS
      : 1,
    MAX_TTL_SECONDS,
    issues,
  );
  const roomCodeTtlSeconds = parseInteger(
    'ROOM_CODE_TTL_SECONDS',
    raw.ROOM_CODE_TTL_SECONDS,
    1,
    MAX_TTL_SECONDS,
    issues,
  );
  const roomDisconnectGraceSeconds = parseInteger(
    'ROOM_DISCONNECT_GRACE_SECONDS',
    raw.ROOM_DISCONNECT_GRACE_SECONDS,
    1,
    MAX_TTL_SECONDS,
    issues,
  );
  const screenLeaseTtlSeconds = parseInteger(
    'SCREEN_LEASE_TTL_SECONDS',
    raw.SCREEN_LEASE_TTL_SECONDS,
    1,
    MAX_TTL_SECONDS,
    issues,
  );
  const screenBitrateMin = parseInteger(
    'SCREEN_BITRATE_MIN',
    raw.SCREEN_BITRATE_MIN,
    1_000_000,
    10_000_000,
    issues,
  );
  const screenBitrateMax = parseInteger(
    'SCREEN_BITRATE_MAX',
    raw.SCREEN_BITRATE_MAX,
    1_000_000,
    10_000_000,
    issues,
  );

  if (
    screenBitrateMin !== undefined &&
    screenBitrateMax !== undefined &&
    screenBitrateMin > screenBitrateMax
  ) {
    addIssue(
      issues,
      'SCREEN_BITRATE_MIN',
      'must be less than or equal to SCREEN_BITRATE_MAX',
    );
  }

  if (raw.NODE_ENV === 'production') {
    if (publicUrl) {
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:') {
        addIssue(issues, 'PUBLIC_URL', 'must use HTTPS in production');
      }
      if (!isValidNormalizedUrlHostname(url.hostname)) {
        addIssue(
          issues,
          'PUBLIC_URL',
          'must use a valid DNS hostname or IP address in production',
        );
      }
      if (isLoopbackOrWildcardHostname(url.hostname)) {
        addIssue(
          issues,
          'PUBLIC_URL',
          'must not use localhost, a loopback IP, or a wildcard IP in production',
        );
      }
    }
    if (turnHost !== undefined && isLoopbackOrWildcardHostname(turnHost)) {
      addIssue(
        issues,
        'TURN_HOST',
        'must not use localhost, a loopback IP, or a wildcard IP in production',
      );
    }
    validateProductionGeneratedSecret(
      'JWT_ACCESS_SECRET',
      raw.JWT_ACCESS_SECRET,
      issues,
    );
    validateProductionGeneratedSecret(
      'TURN_SHARED_SECRET',
      raw.TURN_SHARED_SECRET,
      issues,
    );
  }

  if (issues.length > 0) {
    throw new ServerConfigError(issues);
  }

  if (
    serverPort === undefined ||
    turnCredentialTtlSeconds === undefined ||
    roomCodeTtlSeconds === undefined ||
    roomDisconnectGraceSeconds === undefined ||
    screenLeaseTtlSeconds === undefined ||
    screenBitrateMin === undefined ||
    screenBitrateMax === undefined ||
    turnHost === undefined
  ) {
    throw new ServerConfigError([
      { field: 'SERVER_CONFIG', reason: 'contains invalid numeric values' },
    ]);
  }

  return freezeConfig({
    nodeEnv: raw.NODE_ENV,
    server: { host: raw.SERVER_HOST, port: serverPort },
    publicUrl,
    database: { url: databaseUrl },
    auth: { jwtAccessSecret: raw.JWT_ACCESS_SECRET },
    turn: {
      sharedSecret: raw.TURN_SHARED_SECRET,
      realm: raw.TURN_REALM,
      host: turnHost,
      urls: turnUrls,
      credentialTtlSeconds: turnCredentialTtlSeconds,
    },
    room: {
      codeTtlSeconds: roomCodeTtlSeconds,
      disconnectGraceSeconds: roomDisconnectGraceSeconds,
    },
    screen: {
      leaseTtlSeconds: screenLeaseTtlSeconds,
      bitrateRange: { min: screenBitrateMin, max: screenBitrateMax },
    },
  });
};
