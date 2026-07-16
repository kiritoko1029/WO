import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from 'node:crypto';
import { isIPv4 } from 'node:net';
import { rootCertificates } from 'node:tls';

const requiredFields = Object.freeze([
  'APP_DOMAIN',
  'ACME_EMAIL',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'PUBLIC_IPV4',
  'TURN_HOST',
  'TURN_REALM',
  'TURN_PORT',
  'TURN_TLS_PORT',
  'TURN_RELAY_MIN_PORT',
  'TURN_RELAY_MAX_PORT',
  'TURN_URLS',
  'BACKUP_DIR',
  'DEPLOY_SECRET_DIR',
]);

const hostnamePattern =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const databaseIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const turnUrlPattern =
  /^(stun|turn|turns):(?:\[([^\]]+)\]|([^:?/#]+))(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/i;

function ipv4Number(value) {
  return value
    .split('.')
    .map(Number)
    .reduce((number, octet) => ((number << 8) | octet) >>> 0, 0);
}

function inIpv4Range(value, first, last) {
  const number = ipv4Number(value);
  return number >= ipv4Number(first) && number <= ipv4Number(last);
}

const nonPublicIpv4Ranges = Object.freeze([
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'],
  ['192.0.2.0', '192.0.2.255'],
  ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'],
  ['224.0.0.0', '255.255.255.255'],
]);

export function isPublicIpv4(value) {
  return (
    isIPv4(value) &&
    !nonPublicIpv4Ranges.some(([first, last]) =>
      inIpv4Range(value, first, last),
    )
  );
}

export function parseDotEnv(source) {
  const result = {};
  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 1) {
      throw new Error(`Invalid environment line ${index + 1}`);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
      throw new Error(`Invalid environment key on line ${index + 1}`);
    }
    if (Object.hasOwn(result, key)) {
      throw new Error(`Duplicate environment key: ${key}`);
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/\p{Cc}/u.test(value)) {
      throw new Error(`Control character in environment value: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

function integer(value) {
  return /^[0-9]+$/u.test(value ?? '') ? Number(value) : Number.NaN;
}

function validateTurnUrls(environment, issues) {
  const rawUrls = environment.TURN_URLS ?? '';
  const urls = rawUrls.split(',');
  if (urls.length < 2 || urls.length > 8) {
    issues.push('TURN_URLS must contain between 2 and 8 self-hosted URLs');
    return;
  }
  let hasTurn = false;
  for (const url of urls) {
    const match = turnUrlPattern.exec(url);
    if (match === null) {
      issues.push(`TURN_URLS contains an invalid URL: ${url}`);
      continue;
    }
    const scheme = match[1].toLowerCase();
    const hostname = (match[2] ?? match[3] ?? '').toLowerCase();
    if (hostname !== environment.TURN_HOST?.toLowerCase()) {
      issues.push('Every TURN_URLS hostname must equal TURN_HOST');
    }
    if (scheme !== 'stun') {
      hasTurn = true;
    }
    const transport = match[5]?.toLowerCase();
    if (
      (scheme === 'stun' && transport !== undefined) ||
      (scheme === 'turns' && transport !== undefined && transport !== 'tcp')
    ) {
      issues.push(`TURN_URLS contains an invalid transport for ${scheme}`);
    }
    const secure = scheme === 'turns';
    const expectedPort = secure
      ? Number(environment.TURN_TLS_PORT)
      : Number(environment.TURN_PORT);
    const defaultPort = secure ? 5349 : 3478;
    const actualPort = match[4] === undefined ? defaultPort : Number(match[4]);
    if (actualPort !== expectedPort) {
      issues.push(
        `${secure ? 'TURN_TLS_PORT' : 'TURN_PORT'} must match every ${secure ? 'turns' : 'stun/turn'} URL`,
      );
    }
  }
  if (!hasTurn) {
    issues.push('TURN_URLS must contain at least one TURN relay URL');
  }
}

export function validateDeploymentEnvironment(
  environment,
  { platform = process.platform, integration = false } = {},
) {
  const issues = [];
  if (!integration && platform !== 'linux') {
    issues.push('Production deployment requires a Linux Docker host');
  }
  for (const field of requiredFields) {
    const value = environment[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push(`${field} is required`);
    } else if (/change-me|example\.invalid|changeme/iu.test(value)) {
      issues.push(`${field} still contains a placeholder value`);
    }
  }
  const appDomain = environment.APP_DOMAIN ?? '';
  const appDomainIsAllowed = integration
    ? /^(?:[a-z0-9-]+\.)*localhost$/iu.test(appDomain)
    : hostnamePattern.test(appDomain) &&
      !/(?:^|\.)localhost$/iu.test(appDomain);
  if (!appDomainIsAllowed) {
    issues.push('APP_DOMAIN must be a public DNS hostname');
  }
  if (!emailPattern.test(environment.ACME_EMAIL ?? '')) {
    issues.push('ACME_EMAIL must be a valid operator email address');
  }
  if (!databaseIdentifierPattern.test(environment.POSTGRES_DB ?? '')) {
    issues.push('POSTGRES_DB must be a safe PostgreSQL identifier');
  }
  if (!databaseIdentifierPattern.test(environment.POSTGRES_USER ?? '')) {
    issues.push('POSTGRES_USER must be a safe PostgreSQL identifier');
  }
  if (
    integration
      ? environment.PUBLIC_IPV4 !== '127.0.0.1'
      : !isPublicIpv4(environment.PUBLIC_IPV4 ?? '')
  ) {
    issues.push('PUBLIC_IPV4 must be a public unicast IPv4 address');
  }
  for (const field of ['TURN_HOST', 'TURN_REALM']) {
    if (!hostnamePattern.test(environment[field] ?? '')) {
      issues.push(`${field} must be a valid DNS hostname`);
    }
  }

  const turnPort = integer(environment.TURN_PORT);
  const turnTlsPort = integer(environment.TURN_TLS_PORT);
  const relayMinimum = integer(environment.TURN_RELAY_MIN_PORT);
  const relayMaximum = integer(environment.TURN_RELAY_MAX_PORT);
  for (const [field, value] of [
    ['TURN_PORT', turnPort],
    ['TURN_TLS_PORT', turnTlsPort],
    ['TURN_RELAY_MIN_PORT', relayMinimum],
    ['TURN_RELAY_MAX_PORT', relayMaximum],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      issues.push(`${field} must be an integer between 1 and 65535`);
    }
  }
  if (turnPort === turnTlsPort) {
    issues.push('TURN_PORT and TURN_TLS_PORT must be unique');
  }
  if ([turnPort, turnTlsPort].some((port) => port === 80 || port === 443)) {
    issues.push('TURN listener ports conflict with Caddy ports 80/443');
  }
  if (
    Number.isInteger(relayMinimum) &&
    Number.isInteger(relayMaximum) &&
    (relayMinimum > relayMaximum || relayMaximum - relayMinimum + 1 > 200)
  ) {
    issues.push(
      'TURN relay range must be ascending and contain at most 200 ports',
    );
  }
  if (
    [turnPort, turnTlsPort].includes(relayMinimum) ||
    [turnPort, turnTlsPort].includes(relayMaximum) ||
    (relayMinimum < turnPort && turnPort < relayMaximum) ||
    (relayMinimum < turnTlsPort && turnTlsPort < relayMaximum)
  ) {
    issues.push('TURN relay range must not overlap TURN listener ports');
  }
  validateTurnUrls(environment, issues);

  for (const legacySecret of [
    'JWT_ACCESS_SECRET',
    'POSTGRES_PASSWORD',
    'TURN_SHARED_SECRET',
  ]) {
    if (Object.hasOwn(environment, legacySecret)) {
      issues.push(`${legacySecret} must be supplied as a Docker secret file`);
    }
  }
  return issues;
}

export function validateGeneratedSecret(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    return 'Secret must use canonical unpadded base64url';
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    return 'Secret must use canonical unpadded base64url';
  }
  if (bytes.byteLength < 32) {
    return 'Secret must contain at least 32 random bytes';
  }
  if (new Set(value).size < 12) {
    return 'Secret does not contain enough distinct characters';
  }
  return null;
}

export function semverAtLeast(actual, minimum) {
  const parse = (value) =>
    value
      .replace(/^v/u, '')
      .split(/[.+-]/u, 3)
      .map((part) => Number(part));
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (
    actualParts.length < 2 ||
    minimumParts.length < 2 ||
    [...actualParts, ...minimumParts].some((part) => !Number.isInteger(part))
  ) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return true;
}

export function firewallSummary(environment) {
  return [
    `TCP 80,443,${environment.TURN_PORT},${environment.TURN_TLS_PORT}`,
    `UDP ${environment.TURN_PORT},${environment.TURN_TLS_PORT},${environment.TURN_RELAY_MIN_PORT}-${environment.TURN_RELAY_MAX_PORT}`,
  ];
}

const certificateBlockPattern =
  /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

function parsedCertificates(pem) {
  return [...pem.matchAll(certificateBlockPattern)].flatMap(([block]) => {
    try {
      return [new X509Certificate(block)];
    } catch {
      return [];
    }
  });
}

function certificateIsIssuedBy(certificate, issuer) {
  try {
    return (
      certificate.issuer === issuer.subject &&
      certificate.verify(issuer.publicKey)
    );
  } catch {
    return false;
  }
}

function chainReachesTrustRoot(leaf, suppliedChain, trustRoots, now) {
  let current = leaf;
  const remaining = [...suppliedChain];
  const seen = new Set();
  while (!seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    if (
      trustRoots.some(
        (root) =>
          root.fingerprint256 === current.fingerprint256 ||
          certificateIsIssuedBy(current, root),
      )
    ) {
      return true;
    }
    const issuerIndex = remaining.findIndex((candidate) =>
      certificateIsIssuedBy(current, candidate),
    );
    if (issuerIndex === -1) {
      return false;
    }
    current = remaining.splice(issuerIndex, 1)[0];
    if (
      now < Date.parse(current.validFrom) ||
      now >= Date.parse(current.validTo)
    ) {
      return false;
    }
  }
  return false;
}

export function validateTurnTlsIdentity({
  certificatePem,
  privateKeyPem,
  hostname,
  now = Date.now(),
  production = true,
  trustedCertificates = rootCertificates,
}) {
  const issues = [];
  let certificate;
  let suppliedChain = [];
  let privateKey;
  try {
    const certificates = parsedCertificates(certificatePem);
    certificate = certificates[0];
    suppliedChain = certificates.slice(1);
    if (certificate === undefined) {
      throw new Error('certificate missing');
    }
  } catch {
    issues.push('TURN TLS certificate cannot be parsed');
  }
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    issues.push('TURN TLS private key cannot be parsed');
  }
  if (certificate === undefined) {
    return issues;
  }

  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
    issues.push('TURN TLS certificate validity cannot be parsed');
  } else {
    if (now < validFrom) {
      issues.push('TURN TLS certificate is not valid yet');
    }
    const minimumValidity = 7 * 24 * 60 * 60 * 1_000;
    if (validTo - now < minimumValidity) {
      issues.push('TURN TLS certificate must remain valid for at least 7 days');
    }
  }
  if (certificate.checkHost(hostname) === undefined) {
    issues.push('TURN TLS certificate hostname does not match TURN_HOST');
  }
  if (
    production &&
    (certificate.issuer === certificate.subject ||
      certificate.checkIssued(certificate))
  ) {
    issues.push('Production TURN TLS certificate must not be self-issued');
  }
  if (production) {
    const trustRoots = trustedCertificates.flatMap((pem) =>
      parsedCertificates(pem),
    );
    if (!chainReachesTrustRoot(certificate, suppliedChain, trustRoots, now)) {
      issues.push('Production TURN TLS certificate chain is not trusted');
    }
  }
  if (privateKey !== undefined) {
    const certificatePublicKey = certificate.publicKey.export({
      format: 'der',
      type: 'spki',
    });
    const privatePublicKey = createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    });
    if (!certificatePublicKey.equals(privatePublicKey)) {
      issues.push('TURN TLS certificate and private key do not match');
    }
  }
  return issues;
}
