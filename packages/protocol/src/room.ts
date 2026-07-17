import { z } from 'zod';

import {
  connectionEpochSchema,
  createAckEnvelopeSchema,
  createBroadcastEnvelopeSchema,
  createP2pAckEnvelopeSchema,
  createRequestEnvelopeSchema,
  isoDateTimeSchema,
  leaseIdSchema,
  memberIdSchema,
  negotiationIdSchema,
  roomIdSchema,
  userIdSchema,
} from './envelope.js';
import { rtcConfigurationSchema } from './webrtc.js';

export const memberSchema = z
  .object({
    memberId: memberIdSchema,
    displayName: z.string().trim().min(1).max(100),
  })
  .strict();

export const roomJoinPayloadSchema = z
  .object({ roomId: roomIdSchema })
  .strict();
export const roomJoinRequestSchema = createRequestEnvelopeSchema(
  'room.join',
  roomJoinPayloadSchema,
);
export const roomJoinAckDataSchema = z
  .object({ roomId: roomIdSchema, memberId: memberIdSchema })
  .strict();
export const roomJoinAckSchema = createAckEnvelopeSchema(
  'room.join',
  roomJoinAckDataSchema,
);

export const roomLeavePayloadSchema = z
  .object({ roomId: roomIdSchema })
  .strict();
export const roomLeaveRequestSchema = createRequestEnvelopeSchema(
  'room.leave',
  roomLeavePayloadSchema,
);
export const roomLeaveAckSchema = createAckEnvelopeSchema(
  'room.leave',
  z.object({}).strict(),
);

export const roomMemberJoinedPayloadSchema = z
  .object({ roomId: roomIdSchema, member: memberSchema })
  .strict();
export const roomMemberJoinedBroadcastSchema = createBroadcastEnvelopeSchema(
  'room.member.joined',
  roomMemberJoinedPayloadSchema,
);

export const memberLeftReasonSchema = z.enum([
  'left',
  'disconnected',
  'removed',
]);
export const roomMemberLeftPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    memberId: memberIdSchema,
    reason: memberLeftReasonSchema,
  })
  .strict();
export const roomMemberLeftBroadcastSchema = createBroadcastEnvelopeSchema(
  'room.member.left',
  roomMemberLeftPayloadSchema,
);

export type Member = z.infer<typeof memberSchema>;
export type RoomJoinRequest = z.infer<typeof roomJoinRequestSchema>;
export type RoomJoinAck = z.infer<typeof roomJoinAckSchema>;
export type RoomLeaveRequest = z.infer<typeof roomLeaveRequestSchema>;
export type RoomLeaveAck = z.infer<typeof roomLeaveAckSchema>;
export type RoomMemberJoinedBroadcast = z.infer<
  typeof roomMemberJoinedBroadcastSchema
>;
export type RoomMemberLeftBroadcast = z.infer<
  typeof roomMemberLeftBroadcastSchema
>;

export const roomCodeSchema = z.string().regex(/^\d{6}$/);
export const roomRoleSchema = z.enum(['creator', 'joiner']);
export const roomStateSchema = z.enum([
  'waiting',
  'negotiating',
  'connected',
  'reconnecting',
  'closed',
]);

export const peerSummarySchema = z
  .object({
    userId: userIdSchema,
    displayName: z.string().trim().min(1).max(100),
    ready: z.boolean(),
  })
  .strict();

export const screenOwnerSnapshotSchema = z
  .object({
    owner: peerSummarySchema.nullable(),
    leaseId: leaseIdSchema.nullable(),
    leaseExpiresAt: isoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const allNull =
      value.owner === null &&
      value.leaseId === null &&
      value.leaseExpiresAt === null;
    const allPresent =
      value.owner !== null &&
      value.leaseId !== null &&
      value.leaseExpiresAt !== null;
    if (!allNull && !allPresent) {
      context.addIssue({
        code: 'custom',
        message: 'screen owner and lease fields must change together',
      });
    }
  });

export const roomActiveStateSchema = z.enum([
  'negotiating',
  'connected',
  'reconnecting',
]);

const roomSessionCommonShape = {
  roomId: roomIdSchema,
  connectionEpoch: connectionEpochSchema,
  rtcConfiguration: rtcConfigurationSchema,
  iceCredentialsExpiresAt: isoDateTimeSchema,
  screen: screenOwnerSnapshotSchema,
} as const;

export const creatorWaitingRoomSessionSchema = z
  .object({
    ...roomSessionCommonShape,
    role: z.literal('creator'),
    state: z.literal('waiting'),
    peer: z.null(),
  })
  .strict();

export const creatorActiveRoomSessionSchema = z
  .object({
    ...roomSessionCommonShape,
    role: z.literal('creator'),
    state: roomActiveStateSchema,
    peer: peerSummarySchema,
  })
  .strict();

export const joinerActiveRoomSessionSchema = z
  .object({
    ...roomSessionCommonShape,
    role: z.literal('joiner'),
    state: roomActiveStateSchema,
    peer: peerSummarySchema,
  })
  .strict();

export const roomSessionAckDataSchema = z.union([
  creatorWaitingRoomSessionSchema,
  creatorActiveRoomSessionSchema,
  joinerActiveRoomSessionSchema,
]);

export const roomCreatePayloadSchema = z.object({}).strict();
export const roomCreateRequestSchema = createRequestEnvelopeSchema(
  'room.create',
  roomCreatePayloadSchema,
);
export const roomCreateAckDataSchema = creatorWaitingRoomSessionSchema.extend({
  roomCode: roomCodeSchema,
});
export const roomCreateAckSchema = createP2pAckEnvelopeSchema(
  'room.create',
  roomCreateAckDataSchema,
);

export const p2pRoomJoinPayloadSchema = z
  .object({
    roomCode: roomCodeSchema,
  })
  .strict();
export const p2pRoomJoinRequestSchema = createRequestEnvelopeSchema(
  'room.join',
  p2pRoomJoinPayloadSchema,
);
export const p2pRoomJoinAckDataSchema = joinerActiveRoomSessionSchema;
export const p2pRoomJoinAckSchema = createP2pAckEnvelopeSchema(
  'room.join',
  p2pRoomJoinAckDataSchema,
);

export const roomResumePayloadSchema = z
  .object({
    roomId: roomIdSchema,
  })
  .strict();
export const roomResumeRequestSchema = createRequestEnvelopeSchema(
  'room.resume',
  roomResumePayloadSchema,
);

export const roomResumeDispositionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }).strict(),
  z
    .object({
      status: z.literal('completed'),
      negotiationId: negotiationIdSchema,
      negotiationGeneration: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      status: z.literal('reset_required'),
      negotiationId: negotiationIdSchema,
      resetGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      reason: z.enum(['peer_resumed', 'signaling_reset']),
    })
    .strict(),
]);

export const roomResumeAckDataSchema = z.union([
  creatorWaitingRoomSessionSchema.extend({
    resume: roomResumeDispositionSchema,
  }),
  creatorActiveRoomSessionSchema.extend({
    resume: roomResumeDispositionSchema,
  }),
  joinerActiveRoomSessionSchema.extend({
    resume: roomResumeDispositionSchema,
  }),
]);
export const roomResumeAckSchema = createP2pAckEnvelopeSchema(
  'room.resume',
  roomResumeAckDataSchema,
);

export const p2pRoomLeaveRequestSchema = createRequestEnvelopeSchema(
  'room.leave',
  roomLeavePayloadSchema,
);
export const p2pRoomLeaveAckSchema = createP2pAckEnvelopeSchema(
  'room.leave',
  z.object({}).strict(),
);

export const roomEndPayloadSchema = z
  .object({
    roomId: roomIdSchema,
  })
  .strict();
export const roomEndRequestSchema = createRequestEnvelopeSchema(
  'room.end',
  roomEndPayloadSchema,
);
export const roomEndAckSchema = createP2pAckEnvelopeSchema(
  'room.end',
  z.object({}).strict(),
);

export const peerReadyPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    connectionEpoch: connectionEpochSchema,
  })
  .strict();
export const peerReadyRequestSchema = createRequestEnvelopeSchema(
  'peer.ready',
  peerReadyPayloadSchema,
);
export const peerReadyAckSchema = createP2pAckEnvelopeSchema(
  'peer.ready',
  z.object({}).strict(),
);

export const peerJoinedPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    peer: peerSummarySchema,
  })
  .strict();
export const peerJoinedBroadcastSchema = createBroadcastEnvelopeSchema(
  'peer.joined',
  peerJoinedPayloadSchema,
);

export const peerLeftReasonSchema = z.enum([
  'left',
  'disconnected',
  'replaced',
]);
export const peerLeftPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    userId: userIdSchema,
    reason: peerLeftReasonSchema,
  })
  .strict();
export const peerLeftBroadcastSchema = createBroadcastEnvelopeSchema(
  'peer.left',
  peerLeftPayloadSchema,
);

export const peerReadyBroadcastPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    peer: peerSummarySchema,
  })
  .strict();
export const peerReadyBroadcastSchema = createBroadcastEnvelopeSchema(
  'peer.ready',
  peerReadyBroadcastPayloadSchema,
);

export const roomClosedReasonSchema = z.enum([
  'ended',
  'creator_left',
  'expired',
  'signaling_error',
]);
export const roomClosedPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    reason: roomClosedReasonSchema,
  })
  .strict();
export const roomClosedBroadcastSchema = createBroadcastEnvelopeSchema(
  'room.closed',
  roomClosedPayloadSchema,
);

export type RoomCode = z.infer<typeof roomCodeSchema>;
export type RoomRole = z.infer<typeof roomRoleSchema>;
export type RoomState = z.infer<typeof roomStateSchema>;
export type PeerSummary = z.infer<typeof peerSummarySchema>;
export type RoomActiveState = z.infer<typeof roomActiveStateSchema>;
export type CreatorWaitingRoomSession = z.infer<
  typeof creatorWaitingRoomSessionSchema
>;
export type CreatorActiveRoomSession = z.infer<
  typeof creatorActiveRoomSessionSchema
>;
export type JoinerActiveRoomSession = z.infer<
  typeof joinerActiveRoomSessionSchema
>;
export type RoomSessionAckData = z.infer<typeof roomSessionAckDataSchema>;
export type ScreenOwnerSnapshot = z.infer<typeof screenOwnerSnapshotSchema>;
export type RoomCreatePayload = z.infer<typeof roomCreatePayloadSchema>;
export type RoomCreateAckData = z.infer<typeof roomCreateAckDataSchema>;
export type RoomCreateRequest = z.infer<typeof roomCreateRequestSchema>;
export type RoomCreateAck = z.infer<typeof roomCreateAckSchema>;
export type P2pRoomJoinPayload = z.infer<typeof p2pRoomJoinPayloadSchema>;
export type P2pRoomJoinRequest = z.infer<typeof p2pRoomJoinRequestSchema>;
export type P2pRoomJoinAckData = z.infer<typeof p2pRoomJoinAckDataSchema>;
export type P2pRoomJoinAck = z.infer<typeof p2pRoomJoinAckSchema>;
export type RoomResumePayload = z.infer<typeof roomResumePayloadSchema>;
export type RoomResumeRequest = z.infer<typeof roomResumeRequestSchema>;
export type RoomResumeDisposition = z.infer<typeof roomResumeDispositionSchema>;
export type RoomResumeAckData = z.infer<typeof roomResumeAckDataSchema>;
export type RoomResumeAck = z.infer<typeof roomResumeAckSchema>;
export type P2pRoomLeaveRequest = z.infer<typeof p2pRoomLeaveRequestSchema>;
export type P2pRoomLeaveAck = z.infer<typeof p2pRoomLeaveAckSchema>;
export type RoomEndPayload = z.infer<typeof roomEndPayloadSchema>;
export type RoomEndRequest = z.infer<typeof roomEndRequestSchema>;
export type RoomEndAck = z.infer<typeof roomEndAckSchema>;
export type PeerReadyPayload = z.infer<typeof peerReadyPayloadSchema>;
export type PeerReadyRequest = z.infer<typeof peerReadyRequestSchema>;
export type PeerReadyAck = z.infer<typeof peerReadyAckSchema>;
export type PeerJoinedPayload = z.infer<typeof peerJoinedPayloadSchema>;
export type PeerJoinedBroadcast = z.infer<typeof peerJoinedBroadcastSchema>;
export type PeerLeftReason = z.infer<typeof peerLeftReasonSchema>;
export type PeerLeftPayload = z.infer<typeof peerLeftPayloadSchema>;
export type PeerLeftBroadcast = z.infer<typeof peerLeftBroadcastSchema>;
export type PeerReadyBroadcastPayload = z.infer<
  typeof peerReadyBroadcastPayloadSchema
>;
export type PeerReadyBroadcast = z.infer<typeof peerReadyBroadcastSchema>;
export type RoomClosedReason = z.infer<typeof roomClosedReasonSchema>;
export type RoomClosedPayload = z.infer<typeof roomClosedPayloadSchema>;
export type RoomClosedBroadcast = z.infer<typeof roomClosedBroadcastSchema>;
