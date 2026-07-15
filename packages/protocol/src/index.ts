import { z } from 'zod';

import { authRefreshAckSchema, authRefreshRequestSchema } from './auth.js';
import {
  consumerCreateAckSchema,
  consumerCreateRequestSchema,
  consumerResumeAckSchema,
  consumerResumeRequestSchema,
  producerCloseAckSchema,
  producerCloseRequestSchema,
  producerCreateAckSchema,
  producerCreateRequestSchema,
  screenAcquireAckSchema,
  screenAcquireRequestSchema,
  screenReleaseAckSchema,
  screenReleaseRequestSchema,
  screenRenewAckSchema,
  screenRenewRequestSchema,
  screenSetTargetBitrateAckSchema,
  screenSetTargetBitrateRequestSchema,
  transportConnectAckSchema,
  transportConnectRequestSchema,
  transportCreateAckSchema,
  transportCreateRequestSchema,
} from './media.js';
import {
  roomJoinAckSchema,
  roomJoinRequestSchema,
  roomLeaveAckSchema,
  roomLeaveRequestSchema,
  roomMemberJoinedBroadcastSchema,
  roomMemberLeftBroadcastSchema,
} from './room.js';

export * from './auth.js';
export * from './envelope.js';
export * from './errors.js';
export * from './media.js';
export * from './room.js';

export const inboundEnvelopeSchema = z.discriminatedUnion('type', [
  authRefreshRequestSchema,
  roomJoinRequestSchema,
  roomLeaveRequestSchema,
  transportCreateRequestSchema,
  transportConnectRequestSchema,
  producerCreateRequestSchema,
  producerCloseRequestSchema,
  consumerCreateRequestSchema,
  consumerResumeRequestSchema,
  screenAcquireRequestSchema,
  screenRenewRequestSchema,
  screenReleaseRequestSchema,
  screenSetTargetBitrateRequestSchema,
]);

export const requestEnvelopeSchema = inboundEnvelopeSchema;

export const broadcastEnvelopeSchema = z.discriminatedUnion('type', [
  roomMemberJoinedBroadcastSchema,
  roomMemberLeftBroadcastSchema,
]);

export const ackEnvelopeSchema = z.discriminatedUnion('type', [
  authRefreshAckSchema,
  roomJoinAckSchema,
  roomLeaveAckSchema,
  transportCreateAckSchema,
  transportConnectAckSchema,
  producerCreateAckSchema,
  producerCloseAckSchema,
  consumerCreateAckSchema,
  consumerResumeAckSchema,
  screenAcquireAckSchema,
  screenRenewAckSchema,
  screenReleaseAckSchema,
  screenSetTargetBitrateAckSchema,
]);

export type InboundEnvelope = z.infer<typeof inboundEnvelopeSchema>;
export type RequestEnvelope = InboundEnvelope;
export type BroadcastEnvelope = z.infer<typeof broadcastEnvelopeSchema>;
export type AckEnvelope = z.infer<typeof ackEnvelopeSchema>;
