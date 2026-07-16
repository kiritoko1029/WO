import ipaddr from 'ipaddr.js';
import { z } from 'zod';

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const;

export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];

export type ConfigIssue = Readonly<{
  field: string;
  reason: string;
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

export const requiredString = (maximumLength = 4_096) =>
  z
    .string({ error: 'is required' })
    .trim()
    .min(1, 'is required and must not be empty')
    .max(maximumLength, `must be at most ${maximumLength} characters`);

export const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
};

export const exactString = (maximumLength = 4_096) =>
  z
    .string({ error: 'is required' })
    .min(1, 'is required and must not be empty')
    .max(maximumLength, `must be at most ${maximumLength} characters`)
    .refine((value) => value.trim() === value, {
      message: 'must not contain leading or trailing whitespace',
    })
    .refine((value) => !hasControlCharacter(value), {
      message: 'must not contain control characters',
    });

export const toConfigIssues = (error: z.ZodError): ConfigIssue[] =>
  error.issues.map((issue) => ({
    field: typeof issue.path[0] === 'string' ? issue.path[0] : 'SERVER_CONFIG',
    reason: issue.message,
  }));

export const addIssue = (
  issues: ConfigIssue[],
  field: string,
  reason: string,
) => {
  issues.push({ field, reason });
};

export const parseUrl = (
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

export const parseInteger = (
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

export const isLoopbackOrWildcardHostname = (value: string): boolean => {
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

export const validateProductionCredential = (
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
