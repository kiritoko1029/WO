export interface CertificateGateInput {
  readonly allowSelfSigned: boolean;
  readonly endpoint: string;
  readonly hostname: string;
  readonly verificationResult: string;
}

export function shouldTrustLabCertificate(
  input: CertificateGateInput,
): boolean {
  if (!input.allowSelfSigned) return false;
  if (
    input.verificationResult !== 'net::ERR_CERT_AUTHORITY_INVALID' &&
    input.verificationResult !== 'CERT_AUTHORITY_INVALID'
  ) {
    return false;
  }

  try {
    const endpoint = new URL(input.endpoint);
    return (
      endpoint.protocol === 'wss:' &&
      endpoint.hostname === '127.0.0.1' &&
      input.hostname === endpoint.hostname
    );
  } catch {
    return false;
  }
}
