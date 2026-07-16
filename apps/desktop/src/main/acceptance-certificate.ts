import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';

export interface AcceptanceCertificate {
  readonly data: string;
  readonly issuerCert?: AcceptanceCertificate;
}

export interface AcceptanceCertificateRequest {
  readonly url: string;
  readonly error: string;
  readonly certificate: AcceptanceCertificate;
  readonly pinnedRootSpki: string;
  readonly trustedRoot?: string;
  readonly now?: number;
}

function spkiSha256(certificate: X509Certificate): Buffer {
  return createHash('sha256')
    .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    .digest();
}

function decodePin(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function certificateChain(
  first: AcceptanceCertificate,
): readonly X509Certificate[] {
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  let current: AcceptanceCertificate | undefined = first;
  while (current !== undefined && chain.length < 10) {
    const certificate = new X509Certificate(current.data);
    const identity = certificate.raw.toString('hex');
    if (seen.has(identity)) break;
    seen.add(identity);
    chain.push(certificate);
    current = current.issuerCert;
  }
  return chain;
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

export function acceptsPinnedAcceptanceCertificate(
  request: AcceptanceCertificateRequest,
): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(request.url);
  } catch {
    return false;
  }
  if (
    request.error !== 'net::ERR_CERT_AUTHORITY_INVALID' ||
    (endpoint.protocol !== 'https:' && endpoint.protocol !== 'wss:') ||
    endpoint.hostname !== 'rtc.localhost' ||
    (endpoint.port !== '' && endpoint.port !== '443') ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    return false;
  }

  const expectedPin = decodePin(request.pinnedRootSpki);
  if (expectedPin === null) return false;

  try {
    const reportedChain = certificateChain(request.certificate);
    const trustedRoot =
      request.trustedRoot === undefined
        ? null
        : new X509Certificate(request.trustedRoot);
    const reportedRoot = reportedChain.at(-1);
    const chain =
      trustedRoot !== null &&
      (reportedRoot === undefined || !reportedRoot.raw.equals(trustedRoot.raw))
        ? [...reportedChain, trustedRoot]
        : reportedChain;
    if (chain.length < 2) return false;
    const now = request.now ?? Date.now();
    if (
      chain.some((certificate) => !validAt(certificate, now)) ||
      chain[0]!.checkHost(endpoint.hostname) === undefined
    ) {
      return false;
    }
    for (let index = 0; index < chain.length - 1; index += 1) {
      const child = chain[index]!;
      const issuer = chain[index + 1]!;
      if (child.issuer !== issuer.subject || !child.verify(issuer.publicKey)) {
        return false;
      }
    }
    const root = chain.at(-1)!;
    if (root.subject !== root.issuer || !root.verify(root.publicKey)) {
      return false;
    }
    return timingSafeEqual(spkiSha256(root), expectedPin);
  } catch {
    return false;
  }
}
