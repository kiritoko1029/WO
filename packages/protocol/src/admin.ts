import { z } from 'zod';

import { emailSchema, displayNameSchema } from './auth.js';
import { roomIdSchema, userIdSchema } from './envelope.js';

export const adminConnectionSnapshotSchema = z
  .object({
    connectionId: z.string().min(1).max(128),
    userId: userIdSchema,
    email: emailSchema.optional(),
    displayName: displayNameSchema.optional(),
    state: z.enum(['active', 'closing', 'superseded', 'closed']),
    roomId: roomIdSchema.nullable(),
    connectionEpoch: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const adminUserSnapshotSchema = z
  .object({
    userId: userIdSchema,
    email: emailSchema,
    displayName: displayNameSchema,
    verified: z.boolean(),
    disabled: z.boolean(),
    isSuperAdmin: z.boolean(),
    createdAt: z.string().datetime(),
    activeSessions: z.number().int().nonnegative(),
    latestSessionAt: z.string().datetime().nullable(),
    signalingConnections: z.array(adminConnectionSnapshotSchema),
  })
  .strict();

export const adminRoomSnapshotSchema = z
  .object({
    roomId: roomIdSchema,
    state: z.string().min(1).max(32),
    memberCount: z.number().int().nonnegative(),
    onlineCount: z.number().int().nonnegative(),
    hasScreenShare: z.boolean(),
    roomCode: z.string().nullable(),
  })
  .strict();

export const adminOverviewSchema = z
  .object({
    generatedAt: z.string().datetime(),
    users: z.array(adminUserSnapshotSchema),
    rooms: z.array(adminRoomSnapshotSchema),
    totals: z
      .object({
        users: z.number().int().nonnegative(),
        activeSessions: z.number().int().nonnegative(),
        signalingConnections: z.number().int().nonnegative(),
        rooms: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const adminDisableUserBodySchema = z
  .object({
    disabled: z.boolean(),
  })
  .strict();

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminUserSnapshot = z.infer<typeof adminUserSnapshotSchema>;
export type AdminRoomSnapshot = z.infer<typeof adminRoomSnapshotSchema>;
export type AdminConnectionSnapshot = z.infer<
  typeof adminConnectionSnapshotSchema
>;

/** Public metadata written by the certificate worker, without credentials or paths. */
export const deploymentCertificateWorkerStatusSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['acme', 'local', 'external']),
    state: z.enum(['starting', 'ready', 'error']),
    lastAttemptAt: z.string().datetime(),
    lastSuccessAt: z.string().datetime().nullable(),
    errorCode: z
      .enum(['ISSUANCE_FAILED', 'RENEWAL_FAILED', 'IMPORT_FAILED'])
      .nullable(),
  })
  .strict();

export const adminDeploymentStatusSchema = z
  .object({
    enabled: z.boolean(),
    generatedAt: z.string().datetime(),
    publicUrl: z.string().url().max(2048),
    adminUrl: z.string().url().max(2048),
    turnHost: z.string().min(1).max(253),
    turnUrls: z.array(z.string().max(2048)).max(8),
    emailVerificationRequired: z.boolean(),
    smtpConfigured: z.boolean(),
    certificate: z
      .object({
        mode: z.enum(['acme', 'local', 'external', 'manual']),
        state: z.enum([
          'pending',
          'ready',
          'error',
          'unavailable',
          'unmanaged',
        ]),
        autoRenew: z.boolean(),
        stale: z.boolean(),
        lastAttemptAt: z.string().datetime().nullable(),
        lastSuccessAt: z.string().datetime().nullable(),
        errorCode: z
          .enum(['ISSUANCE_FAILED', 'RENEWAL_FAILED', 'IMPORT_FAILED'])
          .nullable(),
        details: z
          .object({
            subject: z.string().max(2048),
            issuer: z.string().max(2048),
            fingerprint256: z.string().max(128),
            validFrom: z.string().datetime(),
            validTo: z.string().datetime(),
            daysRemaining: z.number().int(),
            matchesPublicHost: z.boolean(),
            matchesTurnHost: z.boolean(),
          })
          .strict()
          .nullable(),
        alerts: z
          .array(
            z.enum([
              'LOCAL_CERTIFICATE',
              'STATUS_UNAVAILABLE',
              'STATUS_STALE',
              'CERTIFICATE_PENDING',
              'CERTIFICATE_EXPIRED',
              'CERTIFICATE_EXPIRING',
              'CERTIFICATE_NOT_YET_VALID',
              'HOST_MISMATCH',
              'ISSUANCE_FAILED',
              'RENEWAL_FAILED',
              'IMPORT_FAILED',
            ]),
          )
          .max(10),
      })
      .strict(),
  })
  .strict();

export type AdminDeploymentStatus = z.infer<typeof adminDeploymentStatusSchema>;
