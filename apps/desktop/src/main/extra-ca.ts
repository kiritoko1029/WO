import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import * as tls from 'node:tls';

const certificatePattern =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu;

export interface ExtraCaDependencies {
  readonly getDefaultCertificates?: () => readonly string[];
  readonly setDefaultCertificates?: (certificates: string[]) => void;
}

export function installExtraCaFromEnvironment(
  environment: NodeJS.ProcessEnv,
  dependencies: ExtraCaDependencies = {},
): boolean {
  const configuredPath = environment.WO_EXTRA_CA_CERTS?.trim();
  if (configuredPath === undefined || configuredPath === '') return false;
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
  const certificates = source.match(certificatePattern) ?? [];
  if (
    certificates.length === 0 ||
    certificates.length > 16 ||
    source.replace(certificatePattern, '').trim() !== ''
  ) {
    throw new TypeError('WO_EXTRA_CA_CERTS must contain only certificates');
  }
  for (const certificate of certificates) {
    new X509Certificate(certificate);
  }

  const current =
    dependencies.getDefaultCertificates?.() ?? tls.getCACertificates('default');
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
  install([...current, ...certificates]);
  return true;
}
