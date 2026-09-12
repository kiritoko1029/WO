import { X509Certificate } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

import type { P2pServerConfig } from '@wo/config';
import {
  adminDeploymentStatusSchema,
  deploymentCertificateWorkerStatusSchema,
  type AdminDeploymentStatus,
} from '@wo/protocol';

const DAY_MS = 86_400_000;

async function readPublicFile(
  directory: string,
  filename: string,
  limit: number,
): Promise<string | null> {
  let file;
  try {
    file = await open(join(directory, filename), 'r');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Invalid public status file');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Invalid public status file');
    return buffer.toString('utf8', 0, size);
  } finally {
    await file.close();
  }
}

function certificateMatches(
  certificate: X509Certificate,
  hostname: string,
): boolean {
  const host = hostname.replace(/^\[|\]$/gu, '');
  return isIP(host)
    ? certificate.checkIP(host) !== undefined
    : certificate.checkHost(host) !== undefined;
}

function boundedCertificateLabel(value: string): string {
  return value.replace(/[\r\n\t]/gu, ', ').slice(0, 2048);
}

export function createDeploymentStatusReader(
  config: Pick<P2pServerConfig, 'publicUrl' | 'turn' | 'email' | 'deployment'>,
  now: () => number = Date.now,
): () => Promise<AdminDeploymentStatus> {
  return async () => {
    const timestamp = now();
    const publicOrigin = new URL(config.publicUrl).origin;
    const managed = config.deployment;
    const certificate: AdminDeploymentStatus['certificate'] = {
      mode: managed?.certificateMode ?? 'manual',
      state: managed === undefined ? 'unmanaged' : 'pending',
      autoRenew:
        managed !== undefined && managed.certificateMode !== 'external',
      stale: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      errorCode: null,
      details: null,
      alerts: managed?.certificateMode === 'local' ? ['LOCAL_CERTIFICATE'] : [],
    };
    if (managed !== undefined) {
      try {
        const [statusText, publicPem] = await Promise.all([
          readPublicFile(managed.statusDir, 'status.json', 16_384),
          readPublicFile(managed.statusDir, 'certificate.pem', 65_536),
        ]);
        if (statusText !== null) {
          const status = deploymentCertificateWorkerStatusSchema.parse(
            JSON.parse(statusText),
          );
          if (
            status.mode !== managed.certificateMode ||
            Date.parse(status.lastAttemptAt) > timestamp + 300_000
          ) {
            throw new Error('Invalid certificate status');
          }
          certificate.state =
            status.state === 'starting' ? 'pending' : status.state;
          certificate.lastAttemptAt = status.lastAttemptAt;
          certificate.lastSuccessAt = status.lastSuccessAt;
          certificate.errorCode = status.errorCode;
          certificate.stale =
            timestamp - Date.parse(status.lastAttemptAt) > 2 * DAY_MS;
          if (certificate.stale) certificate.alerts.push('STATUS_STALE');
          if (status.errorCode !== null)
            certificate.alerts.push(status.errorCode);
        }
        if (publicPem !== null) {
          if (publicPem.includes('PRIVATE KEY'))
            throw new Error('Invalid public certificate');
          const leaf = new X509Certificate(publicPem);
          const validFrom = new Date(leaf.validFrom).toISOString();
          const validTo = new Date(leaf.validTo).toISOString();
          const daysRemaining = Math.floor(
            (Date.parse(validTo) - timestamp) / DAY_MS,
          );
          const matchesPublicHost = certificateMatches(
            leaf,
            new URL(publicOrigin).hostname,
          );
          const matchesTurnHost = certificateMatches(leaf, config.turn.host);
          certificate.details = {
            subject: boundedCertificateLabel(leaf.subject),
            issuer: boundedCertificateLabel(leaf.issuer),
            fingerprint256: leaf.fingerprint256,
            validFrom,
            validTo,
            daysRemaining,
            matchesPublicHost,
            matchesTurnHost,
          };
          if (Date.parse(validTo) <= timestamp)
            certificate.alerts.push('CERTIFICATE_EXPIRED');
          else if (daysRemaining < 21)
            certificate.alerts.push('CERTIFICATE_EXPIRING');
          if (Date.parse(validFrom) > timestamp)
            certificate.alerts.push('CERTIFICATE_NOT_YET_VALID');
          if (!matchesPublicHost || !matchesTurnHost)
            certificate.alerts.push('HOST_MISMATCH');
        } else {
          certificate.alerts.push('CERTIFICATE_PENDING');
          if (certificate.state === 'ready') certificate.state = 'pending';
        }
        if (statusText === null && publicPem !== null) {
          certificate.state = 'unavailable';
          certificate.alerts.push('STATUS_UNAVAILABLE');
        }
      } catch {
        certificate.state = 'unavailable';
        certificate.alerts.push('STATUS_UNAVAILABLE');
      }
    }
    return adminDeploymentStatusSchema.parse({
      enabled: managed !== undefined,
      generatedAt: new Date(timestamp).toISOString(),
      publicUrl: publicOrigin,
      adminUrl: new URL('/admin', publicOrigin).href,
      turnHost: config.turn.host,
      turnUrls: [...config.turn.urls],
      emailVerificationRequired: config.email.verificationRequired,
      smtpConfigured: config.email.smtp !== null,
      certificate,
    });
  };
}
