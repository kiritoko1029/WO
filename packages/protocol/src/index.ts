import { z } from 'zod';

import { authRefreshAckSchema, authRefreshRequestSchema } from './auth.js';
import { protocolErrorResponseSchema } from './envelope.js';
import {
  consumerCreateAckSchema,
  consumerCreateRequestSchema,
  consumerResumeAckSchema,
  consumerResumeRequestSchema,
  producerCloseAckSchema,
  producerCloseRequestSchema,
  producerCreateAckSchema,
  producerCreateRequestSchema,
  p2pScreenAcquireAckSchema,
  p2pScreenReleaseAckSchema,
  p2pScreenRenewAckSchema,
  screenAcquireAckSchema,
  screenAcquireRequestSchema,
  screenBitrateAckSchema,
  screenBitrateBroadcastSchema,
  screenBitrateRequestSchema,
  screenOwnerChangedBroadcastSchema,
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
  p2pRoomJoinAckSchema,
  p2pRoomJoinRequestSchema,
  p2pRoomLeaveAckSchema,
  p2pRoomLeaveRequestSchema,
  peerJoinedBroadcastSchema,
  peerLeftBroadcastSchema,
  peerReadyAckSchema,
  peerReadyBroadcastSchema,
  peerReadyRequestSchema,
  roomClosedBroadcastSchema,
  roomCreateAckSchema,
  roomCreateRequestSchema,
  roomEndAckSchema,
  roomEndRequestSchema,
  roomJoinAckSchema,
  roomJoinRequestSchema,
  roomLeaveAckSchema,
  roomLeaveRequestSchema,
  roomMemberJoinedBroadcastSchema,
  roomMemberLeftBroadcastSchema,
  roomResumeAckSchema,
  roomResumeRequestSchema,
} from './room.js';
import {
  webrtcAnswerAckSchema,
  webrtcAnswerAppliedAckSchema,
  webrtcAnswerAppliedRequestSchema,
  webrtcAnswerBroadcastSchema,
  webrtcAnswerRequestSchema,
  webrtcIceCandidateAckSchema,
  webrtcIceCandidateBroadcastSchema,
  webrtcIceCandidateRequestSchema,
  webrtcIceRestartAckSchema,
  webrtcIceRestartBroadcastSchema,
  webrtcIceRestartRequestSchema,
  webrtcIceServersRefreshAckSchema,
  webrtcIceServersRefreshRequestSchema,
  webrtcNegotiationResetBroadcastSchema,
  webrtcOfferAckSchema,
  webrtcOfferBroadcastSchema,
  webrtcOfferRequestSchema,
  webrtcRestartRequestedAckSchema,
  webrtcRestartRequestedBroadcastSchema,
  webrtcRestartRequestedRequestSchema,
  webrtcRecoveryResetAckSchema,
  webrtcRecoveryResetRequestSchema,
} from './webrtc.js';

export * from './auth.js';
export * from './envelope.js';
export * from './errors.js';
export * from './join-intent.js';
export * from './media.js';
export * from './room.js';
export * from './signaling.js';
export * from './webrtc.js';

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

export const p2pRequestEnvelopeSchema = z.discriminatedUnion('type', [
  roomCreateRequestSchema,
  p2pRoomJoinRequestSchema,
  roomResumeRequestSchema,
  p2pRoomLeaveRequestSchema,
  roomEndRequestSchema,
  peerReadyRequestSchema,
  webrtcOfferRequestSchema,
  webrtcAnswerRequestSchema,
  webrtcAnswerAppliedRequestSchema,
  webrtcIceCandidateRequestSchema,
  webrtcIceRestartRequestSchema,
  webrtcRestartRequestedRequestSchema,
  webrtcIceServersRefreshRequestSchema,
  webrtcRecoveryResetRequestSchema,
  screenAcquireRequestSchema,
  screenRenewRequestSchema,
  screenReleaseRequestSchema,
  screenBitrateRequestSchema,
]);

export const p2pAckEnvelopeSchema = z.discriminatedUnion('type', [
  roomCreateAckSchema,
  p2pRoomJoinAckSchema,
  roomResumeAckSchema,
  p2pRoomLeaveAckSchema,
  roomEndAckSchema,
  peerReadyAckSchema,
  webrtcOfferAckSchema,
  webrtcAnswerAckSchema,
  webrtcAnswerAppliedAckSchema,
  webrtcIceCandidateAckSchema,
  webrtcIceRestartAckSchema,
  webrtcRestartRequestedAckSchema,
  webrtcIceServersRefreshAckSchema,
  webrtcRecoveryResetAckSchema,
  p2pScreenAcquireAckSchema,
  p2pScreenRenewAckSchema,
  p2pScreenReleaseAckSchema,
  screenBitrateAckSchema,
]);

export const p2pBroadcastEnvelopeSchema = z.discriminatedUnion('type', [
  peerJoinedBroadcastSchema,
  peerLeftBroadcastSchema,
  peerReadyBroadcastSchema,
  roomClosedBroadcastSchema,
  webrtcOfferBroadcastSchema,
  webrtcAnswerBroadcastSchema,
  webrtcIceCandidateBroadcastSchema,
  webrtcIceRestartBroadcastSchema,
  webrtcRestartRequestedBroadcastSchema,
  webrtcNegotiationResetBroadcastSchema,
  screenOwnerChangedBroadcastSchema,
  screenBitrateBroadcastSchema,
]);

export const p2pOutboundResponseSchema = z.union([
  p2pAckEnvelopeSchema,
  p2pBroadcastEnvelopeSchema,
  protocolErrorResponseSchema,
]);

export type InboundEnvelope = z.infer<typeof inboundEnvelopeSchema>;
export type RequestEnvelope = InboundEnvelope;
export type BroadcastEnvelope = z.infer<typeof broadcastEnvelopeSchema>;
export type AckEnvelope = z.infer<typeof ackEnvelopeSchema>;
export type P2pRequestEnvelope = z.infer<typeof p2pRequestEnvelopeSchema>;
export type P2pAckEnvelope = z.infer<typeof p2pAckEnvelopeSchema>;
export type P2pBroadcastEnvelope = z.infer<typeof p2pBroadcastEnvelopeSchema>;
export type P2pOutboundResponse = z.infer<typeof p2pOutboundResponseSchema>;
