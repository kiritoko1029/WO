import { describe, expect, test } from 'vitest';

describe('media lab self-signed certificate gate', () => {
  test('allows only an authority error for the configured loopback lab endpoint', async () => {
    const { shouldTrustLabCertificate } =
      await import('../src/main/security.js');

    expect(
      shouldTrustLabCertificate({
        allowSelfSigned: true,
        endpoint: 'wss://127.0.0.1:4443',
        hostname: '127.0.0.1',
        verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
      }),
    ).toBe(true);
  });

  test('accepts Electron certificate verifier authority result spelling', async () => {
    const { shouldTrustLabCertificate } =
      await import('../src/main/security.js');

    expect(
      shouldTrustLabCertificate({
        allowSelfSigned: true,
        endpoint: 'wss://127.0.0.1:4443',
        hostname: '127.0.0.1',
        verificationResult: 'CERT_AUTHORITY_INVALID',
      }),
    ).toBe(true);
  });

  test.each([
    [
      false,
      'wss://127.0.0.1:4443',
      '127.0.0.1',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ],
    [
      true,
      'wss://10.0.0.8:4443',
      '10.0.0.8',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ],
    [
      true,
      'wss://127.0.0.1:4443',
      'example.com',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ],
    [true, 'wss://127.0.0.1:4443', '127.0.0.1', 'net::ERR_CERT_DATE_INVALID'],
  ])(
    'rejects a certificate outside the exact opt-in gate',
    async (allowSelfSigned, endpoint, hostname, verificationResult) => {
      const { shouldTrustLabCertificate } =
        await import('../src/main/security.js');

      expect(
        shouldTrustLabCertificate({
          allowSelfSigned,
          endpoint,
          hostname,
          verificationResult,
        }),
      ).toBe(false);
    },
  );
});
