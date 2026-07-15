import { isIP } from 'node:net';

import ipaddr from 'ipaddr.js';
import { z } from 'zod';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export type ConfigIssue = Readonly<{
  field: string;
  reason: string;
}>;

export type ServerConfig = Readonly<{
  nodeEnv: NodeEnvironment;
  publicUrl: string;
  database: Readonly<{ url: string }>;
  redis: Readonly<{ url: string }>;
  rustfs: Readonly<{
    endpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  }>;
  auth: Readonly<{ jwtAccessSecret: string }>;
  turn: Readonly<{ sharedSecret: string }>;
  mediasoup: Readonly<{
    announcedAddress: string;
    workerPortRange: Readonly<{ min: number; max: number }>;
  }>;
  screen: Readonly<{
    bitrateRange: Readonly<{ min: number; max: number }>;
  }>;
}>;

export class ServerConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const safeIssues = issues.map((issue) =>
      Object.freeze({ field: issue.field, reason: issue.reason }),
    );
    super(
      `Invalid server configuration: ${safeIssues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join('; ')}`,
    );
    this.name = 'ServerConfigError';
    this.issues = Object.freeze(safeIssues);
  }
}

const requiredString = (maximumLength = 4_096) =>
  z
    .string({ error: 'is required' })
    .trim()
    .min(1, 'is required and must not be empty')
    .max(maximumLength, `must be at most ${maximumLength} characters`);

const rawEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVIRONMENTS, {
      error: 'must be development, test, or production',
    }),
    PUBLIC_URL: requiredString(2_048),
    DATABASE_URL: requiredString(2_048),
    REDIS_URL: requiredString(2_048),
    RUSTFS_ENDPOINT: requiredString(2_048),
    RUSTFS_REGION: requiredString(63).regex(
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      'must contain lowercase letters, digits, and interior hyphens only',
    ),
    RUSTFS_ACCESS_KEY: requiredString(256),
    RUSTFS_SECRET_KEY: requiredString(256),
    RUSTFS_BUCKET: requiredString(63).regex(
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
      'must be a valid 3-63 character S3 bucket name',
    ),
    JWT_ACCESS_SECRET: requiredString(4_096),
    TURN_SHARED_SECRET: requiredString(4_096),
    MEDIASOUP_ANNOUNCED_ADDRESS: requiredString(253),
    MEDIASOUP_WORKER_PORT_MIN: requiredString(5),
    MEDIASOUP_WORKER_PORT_MAX: requiredString(5),
    SCREEN_BITRATE_MIN: requiredString(10),
    SCREEN_BITRATE_MAX: requiredString(10),
  })
  .strict();

const requiredEnvironmentFields = Object.keys(
  rawEnvironmentSchema.shape,
) as (keyof z.infer<typeof rawEnvironmentSchema>)[];

const toConfigIssues = (error: z.ZodError): ConfigIssue[] =>
  error.issues.map((issue) => ({
    field: typeof issue.path[0] === 'string' ? issue.path[0] : 'SERVER_CONFIG',
    reason: issue.message,
  }));

const addIssue = (issues: ConfigIssue[], field: string, reason: string) => {
  issues.push({ field, reason });
};

const parseUrl = (
  field: string,
  value: string,
  allowedProtocols: readonly string[],
  issues: ConfigIssue[],
  originOnly = false,
): string => {
  try {
    const url = new URL(value);
    if (!url.hostname) {
      addIssue(issues, field, 'must include a hostname');
      return '';
    }
    if (!allowedProtocols.includes(url.protocol)) {
      addIssue(
        issues,
        field,
        `must use one of these URL schemes: ${allowedProtocols.join(', ')}`,
      );
      return '';
    }
    if (originOnly && url.href !== `${url.origin}/`) {
      addIssue(
        issues,
        field,
        'must be an origin without user information, path, query, or fragment',
      );
      return '';
    }
    return url.toString();
  } catch {
    addIssue(
      issues,
      field,
      `must be a valid absolute URL using ${allowedProtocols.join(', ')}`,
    );
    return '';
  }
};

const parseInteger = (
  field: string,
  value: string,
  minimum: number,
  maximum: number,
  issues: ConfigIssue[],
): number | undefined => {
  if (!/^\d+$/.test(value)) {
    addIssue(issues, field, 'must be an integer');
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    addIssue(
      issues,
      field,
      `must be an integer between ${minimum} and ${maximum}`,
    );
    return undefined;
  }

  return parsed;
};

const hostnamePattern =
  /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;

const isValidAnnouncedAddress = (value: string): boolean =>
  isIP(value) !== 0 || hostnamePattern.test(value);

const isPublicIpv4Address = (value: string): boolean =>
  ipaddr.IPv4.isValidFourPartDecimal(value) &&
  ipaddr.IPv4.parse(value).range() === 'unicast';

const isLoopbackOrWildcardHostname = (value: string): boolean => {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return true;
  }

  const addressLiteral =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (!ipaddr.isValid(addressLiteral)) {
    return false;
  }

  const address = ipaddr.parse(addressLiteral);
  const normalizedAddress =
    address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()
      ? address.toIPv4Address()
      : address;
  const range = normalizedAddress.range();
  return range === 'loopback' || range === 'unspecified';
};

const placeholderPattern =
  /(?:change[-_ ]?me|replace[-_ ]?me|placeholder|default|example|your[-_ ])/i;

const validateProductionCredential = (
  field: string,
  value: string,
  minimumLength: number,
  issues: ConfigIssue[],
) => {
  if (placeholderPattern.test(value)) {
    addIssue(issues, field, 'must not use a placeholder value in production');
  } else if (value.length < minimumLength) {
    addIssue(
      issues,
      field,
      `must be at least ${minimumLength} characters in production`,
    );
  }
};

const freezeConfig = (config: ServerConfig): ServerConfig => {
  Object.freeze(config.database);
  Object.freeze(config.redis);
  Object.freeze(config.rustfs);
  Object.freeze(config.auth);
  Object.freeze(config.turn);
  Object.freeze(config.mediasoup.workerPortRange);
  Object.freeze(config.mediasoup);
  Object.freeze(config.screen.bitrateRange);
  Object.freeze(config.screen);
  return Object.freeze(config);
};

export const parseServerConfig = (
  env: Record<string, string | undefined>,
): ServerConfig => {
  const selectedEnvironment = Object.fromEntries(
    requiredEnvironmentFields.map((field) => [field, env[field]]),
  );
  const rawResult = rawEnvironmentSchema.safeParse(selectedEnvironment);

  if (!rawResult.success) {
    throw new ServerConfigError(toConfigIssues(rawResult.error));
  }

  const raw = rawResult.data;
  const issues: ConfigIssue[] = [];
  const publicUrl = parseUrl(
    'PUBLIC_URL',
    raw.PUBLIC_URL,
    ['http:', 'https:'],
    issues,
    true,
  );
  const databaseUrl = parseUrl(
    'DATABASE_URL',
    raw.DATABASE_URL,
    ['postgres:', 'postgresql:'],
    issues,
  );
  const redisUrl = parseUrl(
    'REDIS_URL',
    raw.REDIS_URL,
    ['redis:', 'rediss:'],
    issues,
  );
  const rustfsEndpoint = parseUrl(
    'RUSTFS_ENDPOINT',
    raw.RUSTFS_ENDPOINT,
    ['http:', 'https:'],
    issues,
    true,
  );
  const workerPortMin = parseInteger(
    'MEDIASOUP_WORKER_PORT_MIN',
    raw.MEDIASOUP_WORKER_PORT_MIN,
    1,
    65_535,
    issues,
  );
  const workerPortMax = parseInteger(
    'MEDIASOUP_WORKER_PORT_MAX',
    raw.MEDIASOUP_WORKER_PORT_MAX,
    1,
    65_535,
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
    workerPortMin !== undefined &&
    workerPortMax !== undefined &&
    workerPortMin > workerPortMax
  ) {
    addIssue(
      issues,
      'MEDIASOUP_WORKER_PORT_MIN',
      'must be less than or equal to MEDIASOUP_WORKER_PORT_MAX',
    );
  }
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
  if (!isValidAnnouncedAddress(raw.MEDIASOUP_ANNOUNCED_ADDRESS)) {
    addIssue(
      issues,
      'MEDIASOUP_ANNOUNCED_ADDRESS',
      'must be a valid IP address or hostname',
    );
  }

  if (raw.NODE_ENV === 'production') {
    if (publicUrl) {
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:') {
        addIssue(issues, 'PUBLIC_URL', 'must use HTTPS in production');
      }
      if (isLoopbackOrWildcardHostname(url.hostname)) {
        addIssue(
          issues,
          'PUBLIC_URL',
          'must not use localhost, a loopback IP, or a wildcard IP in production',
        );
      }
    }
    if (!isPublicIpv4Address(raw.MEDIASOUP_ANNOUNCED_ADDRESS)) {
      addIssue(
        issues,
        'MEDIASOUP_ANNOUNCED_ADDRESS',
        'must be a public IPv4 address in production',
      );
    }
    validateProductionCredential(
      'RUSTFS_ACCESS_KEY',
      raw.RUSTFS_ACCESS_KEY,
      8,
      issues,
    );
    validateProductionCredential(
      'RUSTFS_SECRET_KEY',
      raw.RUSTFS_SECRET_KEY,
      32,
      issues,
    );
    validateProductionCredential(
      'JWT_ACCESS_SECRET',
      raw.JWT_ACCESS_SECRET,
      32,
      issues,
    );
    validateProductionCredential(
      'TURN_SHARED_SECRET',
      raw.TURN_SHARED_SECRET,
      32,
      issues,
    );
  }

  if (issues.length > 0) {
    throw new ServerConfigError(issues);
  }

  if (
    workerPortMin === undefined ||
    workerPortMax === undefined ||
    screenBitrateMin === undefined ||
    screenBitrateMax === undefined
  ) {
    throw new ServerConfigError([
      { field: 'SERVER_CONFIG', reason: 'contains invalid numeric values' },
    ]);
  }

  return freezeConfig({
    nodeEnv: raw.NODE_ENV,
    publicUrl,
    database: { url: databaseUrl },
    redis: { url: redisUrl },
    rustfs: {
      endpoint: rustfsEndpoint,
      region: raw.RUSTFS_REGION,
      accessKey: raw.RUSTFS_ACCESS_KEY,
      secretKey: raw.RUSTFS_SECRET_KEY,
      bucket: raw.RUSTFS_BUCKET,
    },
    auth: { jwtAccessSecret: raw.JWT_ACCESS_SECRET },
    turn: { sharedSecret: raw.TURN_SHARED_SECRET },
    mediasoup: {
      announcedAddress: raw.MEDIASOUP_ANNOUNCED_ADDRESS.toLowerCase(),
      workerPortRange: { min: workerPortMin, max: workerPortMax },
    },
    screen: {
      bitrateRange: { min: screenBitrateMin, max: screenBitrateMax },
    },
  });
};
