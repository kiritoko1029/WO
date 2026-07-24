import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import * as tls from 'node:tls';

const certificatePattern =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;

export interface ExtraCaDependencies {
  readonly getDefaultCertificates?: () => readonly string[];
  readonly getSystemCertificates?: () => readonly string[];
  readonly setDefaultCertificates?: (certificates: string[]) => void;
}

export interface ExtraCaCertificate {
  readonly data: string;
  readonly issuerCert?: ExtraCaCertificate;
}

export interface ExtraCaCertificateVerificationRequest {
  readonly hostname: string;
  readonly certificate: ExtraCaCertificate;
  readonly verificationResult: string;
  readonly errorCode: number;
}

export interface ExtraCaCertificateVerifierOptions {
  readonly certificates: readonly string[];
  readonly hostnames: readonly string[];
  readonly now?: () => number;
}

export interface ExtraCaCertificateSession {
  setCertificateVerifyProc(
    handler: (
      request: ExtraCaCertificateVerificationRequest,
      callback: (verificationResult: number) => void,
    ) => void,
  ): void;
}

const ACCEPT_CERTIFICATE = 0;
const REJECT_CERTIFICATE = -2;
const USE_CHROMIUM_CERTIFICATE_RESULT = -3;
const CERT_AUTHORITY_INVALID = -202;
const authorityInvalidResults = new Set([
  'CERT_AUTHORITY_INVALID',
  'ERR_CERT_AUTHORITY_INVALID',
  'net::ERR_CERT_AUTHORITY_INVALID',
]);

export function installExtraCaFromEnvironment(
  environment: NodeJS.ProcessEnv,
  dependencies: ExtraCaDependencies = {},
): readonly string[] {
  const configuredPath = environment.WO_EXTRA_CA_CERTS?.trim();
  const certificates: string[] = [];
  if (configuredPath !== undefined && configuredPath !== '') {
    if (
      configuredPath.length > 4_096 ||
      configuredPath.includes('\0') ||
      !isAbsolute(configuredPath)
    ) {
      throw new TypeError('WO_EXTRA_CA_CERTS must be an absolute file path');
    }

    const source = readFileSync(configuredPath, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > 256 * 1_024) {
      throw new TypeError('WO_EXTRA_CA_CERTS is too large');
    }
    certificates.push(...(source.match(certificatePattern) ?? []));
    if (
      certificates.length === 0 ||
      certificates.length > 16 ||
      source.replace(certificatePattern, '').trim() !== ''
    ) {
      throw new TypeError('WO_EXTRA_CA_CERTS must contain only certificates');
    }
    for (const certificate of certificates) {
      if (!new X509Certificate(certificate).ca) {
        throw new TypeError(
          'WO_EXTRA_CA_CERTS must contain only CA certificates',
        );
      }
    }
  }

  const current =
    dependencies.getDefaultCertificates?.() ?? tls.getCACertificates('default');
  const system =
    dependencies.getSystemCertificates?.() ?? tls.getCACertificates('system');
  const runtimeSetDefaultCertificates = (
    tls as typeof tls & {
      setDefaultCACertificates?: (certificates: string[]) => void;
    }
  ).setDefaultCACertificates;
  const install =
    dependencies.setDefaultCertificates ?? runtimeSetDefaultCertificates;
  if (install === undefined) {
    throw new TypeError('The runtime does not support additional CA files');
  }
  install([...current, ...system, ...certificates]);
  return Object.freeze([...certificates]);
}

function canonicalHostname(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw new TypeError('Extra CA hostname is invalid');
  }
  const unwrapped =
    value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unwrapped) !== 0) return unwrapped.toLowerCase();
  const normalized = value.toLowerCase();
  const endpoint = new URL(`https://${normalized}/`);
  if (
    endpoint.hostname !== normalized ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.port !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new TypeError('Extra CA hostname is invalid');
  }
  const labels = normalized.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new TypeError('Extra CA hostname is invalid');
  }
  return normalized;
}

function certificateChain(
  first: ExtraCaCertificate,
): readonly X509Certificate[] | null {
  try {
    const chain: X509Certificate[] = [];
    const seen = new Set<string>();
    let current: ExtraCaCertificate | undefined = first;
    while (current !== undefined) {
      if (chain.length >= 10) return null;
      const certificate = new X509Certificate(current.data);
      const identity = certificate.raw.toString('hex');
      if (seen.has(identity)) break;
      seen.add(identity);
      chain.push(certificate);
      current = current.issuerCert;
    }
    return chain.length === 0 ? null : chain;
  } catch {
    return null;
  }
}

function validAt(certificate: X509Certificate, now: number): boolean {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  return (
    Number.isFinite(validFrom) &&
    Number.isFinite(validTo) &&
    validFrom <= now &&
    now <= validTo
  );
}

function matchesHostname(
  certificate: X509Certificate,
  hostname: string,
): boolean {
  return isIP(hostname) === 0
    ? certificate.checkHost(hostname) !== undefined
    : certificate.checkIP(hostname) !== undefined;
}

function isTrustedCertificateChain(input: {
  readonly certificate: ExtraCaCertificate;
  readonly hostname: string;
  readonly roots: readonly X509Certificate[];
  readonly now: number;
}): boolean {
  const reportedChain = certificateChain(input.certificate);
  if (reportedChain === null) return false;
  const leaf = reportedChain[0]!;
  if (!matchesHostname(leaf, input.hostname)) return false;

  for (const trustedRoot of input.roots) {
    const reportedRoot = reportedChain.at(-1)!;
    const chain = reportedRoot.raw.equals(trustedRoot.raw)
      ? reportedChain
      : [...reportedChain, trustedRoot];
    if (
      chain.length < 2 ||
      chain.length > 10 ||
      !chain.at(-1)!.raw.equals(trustedRoot.raw) ||
      chain.some((certificate) => !validAt(certificate, input.now))
    ) {
      continue;
    }

    let valid = true;
    for (let index = 0; index < chain.length - 1; index += 1) {
      const child = chain[index]!;
      const issuer = chain[index + 1]!;
      if (
        !issuer.ca ||
        !child.checkIssued(issuer) ||
        !child.verify(issuer.publicKey)
      ) {
        valid = false;
        break;
      }
    }
    if (valid) return true;
  }
  return false;
}

export function createExtraCaCertificateVerifier(
  options: ExtraCaCertificateVerifierOptions,
): (request: ExtraCaCertificateVerificationRequest) => number {
  if (options.certificates.length === 0 || options.certificates.length > 16) {
    throw new TypeError('At least one explicit extra CA is required');
  }
  const roots = options.certificates.map((certificate) => {
    const parsed = new X509Certificate(certificate);
    if (!parsed.ca) {
      throw new TypeError('Extra CA verifier requires CA certificates');
    }
    return parsed;
  });
  if (options.hostnames.length === 0 || options.hostnames.length > 16) {
    throw new TypeError('At least one fixed extra CA hostname is required');
  }
  const hostnames = new Set(options.hostnames.map(canonicalHostname));
  const now = options.now ?? Date.now;

  return (request) => {
    let hostname: string;
    try {
      hostname = canonicalHostname(request.hostname);
    } catch {
      return USE_CHROMIUM_CERTIFICATE_RESULT;
    }
    if (
      !hostnames.has(hostname) ||
      request.errorCode !== CERT_AUTHORITY_INVALID ||
      !authorityInvalidResults.has(request.verificationResult)
    ) {
      return USE_CHROMIUM_CERTIFICATE_RESULT;
    }

    let currentTime: number;
    try {
      currentTime = now();
    } catch {
      return REJECT_CERTIFICATE;
    }
    if (!Number.isFinite(currentTime)) return REJECT_CERTIFICATE;
    return isTrustedCertificateChain({
      certificate: request.certificate,
      hostname,
      roots,
      now: currentTime,
    })
      ? ACCEPT_CERTIFICATE
      : REJECT_CERTIFICATE;
  };
}

export function installExtraCaCertificateVerifier(
  session: ExtraCaCertificateSession,
  options: ExtraCaCertificateVerifierOptions,
): void {
  const verify = createExtraCaCertificateVerifier(options);
  session.setCertificateVerifyProc((request, callback) => {
    callback(verify(request));
  });
}
