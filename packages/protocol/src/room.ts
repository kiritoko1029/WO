import { z } from 'zod';

import {
  createAckEnvelopeSchema,
  createBroadcastEnvelopeSchema,
  createRequestEnvelopeSchema,
  memberIdSchema,
  roomIdSchema,
} from './envelope.js';

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
