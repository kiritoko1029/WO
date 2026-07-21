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
