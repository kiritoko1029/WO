import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExtraCaCertificateVerifier,
  installExtraCaCertificateVerifier,
  installExtraCaFromEnvironment,
  type ExtraCaCertificateVerificationRequest,
} from '../src/main/extra-ca.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('extra CA installation', () => {
  it('adds system certificates without an explicit certificate path', () => {
    const setDefaultCertificates = vi.fn();

    const configured = installExtraCaFromEnvironment(
      {},
      {
        getDefaultCertificates: () => ['default-ca'],
        getSystemCertificates: () => ['system-ca'],
        setDefaultCertificates,
      },
    );

    expect(configured).toEqual([]);
    expect(Object.isFrozen(configured)).toBe(true);
    expect(setDefaultCertificates).toHaveBeenCalledWith([
      'default-ca',
      'system-ca',
    ]);
  });

  it('appends valid PEM certificates to the existing defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wo-extra-ca-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'ca.pem');
    await writeFile(path, rootCertificates[0]!, 'utf8');
    const setDefaultCertificates = vi.fn();

    const configured = installExtraCaFromEnvironment(
      { WO_EXTRA_CA_CERTS: path },
      {
        getDefaultCertificates: () => ['existing-ca'],
        getSystemCertificates: () => ['system-ca'],
        setDefaultCertificates,
      },
    );

    expect(configured).toEqual([rootCertificates[0]]);
    expect(Object.isFrozen(configured)).toBe(true);
    expect(setDefaultCertificates).toHaveBeenCalledWith([
      'existing-ca',
      'system-ca',
      rootCertificates[0],
    ]);
  });

  it('rejects relative paths and non-certificate contents', async () => {
    expect(() =>
      installExtraCaFromEnvironment({
        WO_EXTRA_CA_CERTS: 'relative/ca.pem',
      }),
    ).toThrow(/absolute file path/iu);

    const directory = await mkdtemp(join(tmpdir(), 'wo-extra-ca-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'ca.pem');
    await writeFile(path, 'not a certificate', 'utf8');

    expect(() =>
      installExtraCaFromEnvironment({ WO_EXTRA_CA_CERTS: path }),
    ).toThrow(/only certificates/iu);

    const leafPath = new URL(
      '../../../tests/fixtures/deploy-turn-leaf-cert.pem',
      import.meta.url,
    );
    await writeFile(path, await readFile(leafPath, 'utf8'), 'utf8');
    expect(() =>
      installExtraCaFromEnvironment({ WO_EXTRA_CA_CERTS: path }),
    ).toThrow(/only CA certificates/iu);
  });

  it('accepts only an authority-invalid chain for a fixed hostname and explicit CA', async () => {
    const root = await readFile(
      new URL('../../../tests/fixtures/deploy-turn-cert.pem', import.meta.url),
      'utf8',
    );
    const leaf = await readFile(
      new URL(
        '../../../tests/fixtures/deploy-turn-leaf-cert.pem',
        import.meta.url,
      ),
      'utf8',
    );
    const request = {
      hostname: 'turn.production.example',
      certificate: { data: leaf },
      verificationResult: 'ERR_CERT_AUTHORITY_INVALID',
      errorCode: -202,
    } satisfies ExtraCaCertificateVerificationRequest;
    const verify = createExtraCaCertificateVerifier({
      certificates: [root],
      hostnames: ['turn.production.example'],
      now: () => Date.parse('2026-07-25T00:00:00Z'),
    });

    expect(verify(request)).toBe(0);
    expect(
      verify({
        ...request,
        certificate: { data: leaf, issuerCert: { data: root } },
      }),
    ).toBe(0);
    expect(verify({ ...request, hostname: 'example.invalid' })).toBe(-3);
    expect(
      verify({ ...request, verificationResult: 'CERT_DATE_INVALID' }),
    ).toBe(-3);
    expect(verify({ ...request, errorCode: -201 })).toBe(-3);
  });

  it('rejects mismatched, expired, and hostname-invalid extra-CA chains', async () => {
    const root = await readFile(
      new URL('../../../tests/fixtures/deploy-turn-cert.pem', import.meta.url),
      'utf8',
    );
    const leaf = await readFile(
      new URL(
        '../../../tests/fixtures/deploy-turn-leaf-cert.pem',
        import.meta.url,
      ),
      'utf8',
    );
    const request = {
      hostname: 'turn.production.example',
      certificate: { data: leaf },
      verificationResult: 'CERT_AUTHORITY_INVALID',
      errorCode: -202,
    } satisfies ExtraCaCertificateVerificationRequest;

    expect(
      createExtraCaCertificateVerifier({
        certificates: [rootCertificates[0]!],
        hostnames: [request.hostname],
      })(request),
    ).toBe(-2);
    expect(
      createExtraCaCertificateVerifier({
        certificates: [root],
        hostnames: ['turn.example.com'],
      })({ ...request, hostname: 'turn.example.com' }),
    ).toBe(-2);
    expect(
      createExtraCaCertificateVerifier({
        certificates: [root],
        hostnames: [request.hostname],
        now: () => Date.parse('2030-01-01T00:00:00Z'),
      })(request),
    ).toBe(-2);
    expect(() =>
      createExtraCaCertificateVerifier({
        certificates: [],
        hostnames: [request.hostname],
      }),
    ).toThrow(/explicit extra CA/iu);
    expect(() =>
      createExtraCaCertificateVerifier({
        certificates: [root],
        hostnames: [],
      }),
    ).toThrow(/fixed extra CA hostname/iu);
  });

  it('installs the bounded verifier only after explicit configuration', async () => {
    const root = await readFile(
      new URL('../../../tests/fixtures/deploy-turn-cert.pem', import.meta.url),
      'utf8',
    );
    const leaf = await readFile(
      new URL(
        '../../../tests/fixtures/deploy-turn-leaf-cert.pem',
        import.meta.url,
      ),
      'utf8',
    );
    let handler:
      | ((
          request: ExtraCaCertificateVerificationRequest,
          callback: (verificationResult: number) => void,
        ) => void)
      | undefined;
    const session = {
      setCertificateVerifyProc: vi.fn((next) => {
        handler = next;
      }),
    };
    installExtraCaCertificateVerifier(session, {
      certificates: [root],
      hostnames: ['turn.production.example'],
      now: () => Date.parse('2026-07-25T00:00:00Z'),
    });
    const callback = vi.fn();

    handler?.(
      {
        hostname: 'turn.production.example',
        certificate: { data: leaf },
        verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
        errorCode: -202,
      },
      callback,
    );

    expect(session.setCertificateVerifyProc).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(0);
  });
});
