import { z } from 'zod';

import {
  connectionEpochSchema,
  createBroadcastEnvelopeSchema,
  createP2pAckEnvelopeSchema,
  createRequestEnvelopeSchema,
  isoDateTimeSchema,
  negotiationIdSchema,
  roomIdSchema,
} from './envelope.js';

const sessionDescriptionSdpSchema = z.string().min(1).max(262_144);

export const offerDescriptionSchema = z
  .object({
    type: z.literal('offer'),
    sdp: sessionDescriptionSdpSchema,
  })
  .strict();

export const answerDescriptionSchema = z
  .object({
    type: z.literal('answer'),
    sdp: sessionDescriptionSdpSchema,
  })
  .strict();

export const browserIceCandidateSchema = z
  .object({
    candidate: z.string().max(8_192),
    sdpMid: z.string().max(32).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(32).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

export const iceCandidateInitSchema = browserIceCandidateSchema.nullable();

const iceServerUriPattern =
  /^(stun|turn):(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?(?:\?([^#]*))?$/u;
const hostnameSchema = z.hostname();
const ipv4Schema = z.ipv4();
const ipv6Schema = z.ipv6();

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
};

const isValidIceServerUri = (value: string): boolean => {
  if (hasControlCharacter(value)) {
    return false;
  }

  const match = iceServerUriPattern.exec(value);
  if (match === null) {
    return false;
  }

  const [, scheme, host, port, query] = match;
  const hostIsValid = host.startsWith('[')
    ? ipv6Schema.safeParse(host.slice(1, -1)).success
    : /^[0-9.]+$/u.test(host)
      ? ipv4Schema.safeParse(host).success
      : hostnameSchema.safeParse(host).success;
  if (!hostIsValid) {
    return false;
  }

  if (port !== undefined) {
    const portNumber = Number(port);
    if (portNumber < 1 || portNumber > 65_535) {
      return false;
    }
  }

  if (scheme === 'stun') {
    return query === undefined;
  }

  return (
    query === undefined ||
    query === 'transport=udp' ||
    query === 'transport=tcp'
  );
};

const createIceCredentialSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, {
      message: 'must contain a non-whitespace character',
    })
    .refine((value) => !hasControlCharacter(value), {
      message: 'must not contain control characters',
    });

export const iceServerUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isValidIceServerUri, { message: 'must be a valid STUN or TURN URI' });

export const publicIceServerSchema = z
  .object({
    urls: z.array(iceServerUrlSchema).min(1).max(8),
    username: createIceCredentialSchema(256).optional(),
    credential: createIceCredentialSchema(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasTurnUrl = value.urls.some((url) => url.startsWith('turn:'));
    const hasUsername = value.username !== undefined;
    const hasCredential = value.credential !== undefined;

    if (hasTurnUrl && (!hasUsername || !hasCredential)) {
      context.addIssue({
        code: 'custom',
        message: 'TURN URLs require both username and credential',
      });
    }
    if (!hasTurnUrl && (hasUsername || hasCredential)) {
      context.addIssue({
        code: 'custom',
        message: 'STUN-only entries cannot contain credentials',
      });
    }
  });

export const rtcConfigurationSchema = z
  .object({
    iceServers: z.array(publicIceServerSchema).min(1).max(8),
    iceTransportPolicy: z.enum(['all', 'relay']),
  })
  .strict();

export const iceConfigurationDataSchema = z
  .object({
    rtcConfiguration: rtcConfigurationSchema,
    iceCredentialsExpiresAt: isoDateTimeSchema,
  })
  .strict();

const signalContextShape = {
  roomId: roomIdSchema,
  negotiationId: negotiationIdSchema,
  connectionEpoch: connectionEpochSchema,
} as const;

export const webrtcSignalContextSchema = z.object(signalContextShape).strict();

export const webrtcOfferPayloadSchema = z
  .object({
    ...signalContextShape,
    description: offerDescriptionSchema,
  })
  .strict();
export const webrtcOfferRequestSchema = createRequestEnvelopeSchema(
  'webrtc.offer',
  webrtcOfferPayloadSchema,
);
export const webrtcOfferAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.offer',
  z.object({}).strict(),
);
export const webrtcOfferBroadcastSchema = createBroadcastEnvelopeSchema(
  'webrtc.offer',
  webrtcOfferPayloadSchema,
);

export const webrtcAnswerPayloadSchema = z
  .object({
    ...signalContextShape,
    description: answerDescriptionSchema,
  })
  .strict();
export const webrtcAnswerRequestSchema = createRequestEnvelopeSchema(
  'webrtc.answer',
  webrtcAnswerPayloadSchema,
);
export const webrtcAnswerAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.answer',
  z.object({}).strict(),
);
export const webrtcAnswerBroadcastSchema = createBroadcastEnvelopeSchema(
  'webrtc.answer',
  webrtcAnswerPayloadSchema,
);

export const webrtcAnswerAppliedPayloadSchema = webrtcSignalContextSchema;
export const webrtcAnswerAppliedRequestSchema = createRequestEnvelopeSchema(
  'webrtc.answerApplied',
  webrtcAnswerAppliedPayloadSchema,
);
export const webrtcAnswerAppliedAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.answerApplied',
  z.object({}).strict(),
);

export const webrtcIceCandidatePayloadSchema = z
  .object({
    ...signalContextShape,
    candidate: iceCandidateInitSchema,
  })
  .strict();
export const webrtcIceCandidateRequestSchema = createRequestEnvelopeSchema(
  'webrtc.iceCandidate',
  webrtcIceCandidatePayloadSchema,
);
export const webrtcIceCandidateAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.iceCandidate',
  z.object({}).strict(),
);
export const webrtcIceCandidateBroadcastSchema = createBroadcastEnvelopeSchema(
  'webrtc.iceCandidate',
  webrtcIceCandidatePayloadSchema,
);

export const webrtcIceRestartPayloadSchema = z
  .object({
    ...signalContextShape,
    description: offerDescriptionSchema,
  })
  .strict();
export const webrtcIceRestartRequestSchema = createRequestEnvelopeSchema(
  'webrtc.iceRestart',
  webrtcIceRestartPayloadSchema,
);
export const webrtcIceRestartAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.iceRestart',
  z.object({}).strict(),
);
export const webrtcIceRestartBroadcastSchema = createBroadcastEnvelopeSchema(
  'webrtc.iceRestart',
  webrtcIceRestartPayloadSchema,
);

export const webrtcRestartRequestedPayloadSchema = webrtcSignalContextSchema;
export const webrtcRestartRequestedRequestSchema = createRequestEnvelopeSchema(
  'webrtc.restartRequested',
  webrtcRestartRequestedPayloadSchema,
);
export const webrtcRestartRequestedAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.restartRequested',
  z.object({}).strict(),
);
export const webrtcRestartRequestedBroadcastSchema =
  createBroadcastEnvelopeSchema(
    'webrtc.restartRequested',
    webrtcRestartRequestedPayloadSchema,
  );

export const webrtcIceServersRefreshPayloadSchema = webrtcSignalContextSchema;
export const webrtcIceServersRefreshRequestSchema = createRequestEnvelopeSchema(
  'webrtc.iceServers.refresh',
  webrtcIceServersRefreshPayloadSchema,
);
export const webrtcIceServersRefreshAckSchema = createP2pAckEnvelopeSchema(
  'webrtc.iceServers.refresh',
  iceConfigurationDataSchema,
);

export const negotiationResetReasonSchema = z.enum([
  'peer_resumed',
  'signaling_reset',
]);
export const webrtcNegotiationResetPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    negotiationId: negotiationIdSchema,
    reason: negotiationResetReasonSchema,
  })
  .strict();
export const webrtcNegotiationResetBroadcastSchema =
  createBroadcastEnvelopeSchema(
    'webrtc.negotiationReset',
    webrtcNegotiationResetPayloadSchema,
  );

export type OfferDescription = z.infer<typeof offerDescriptionSchema>;
export type AnswerDescription = z.infer<typeof answerDescriptionSchema>;
export type BrowserIceCandidate = z.infer<typeof browserIceCandidateSchema>;
export type IceCandidateInit = z.infer<typeof iceCandidateInitSchema>;
export type IceServerUrl = z.infer<typeof iceServerUrlSchema>;
export type PublicIceServer = z.infer<typeof publicIceServerSchema>;
export type RtcConfiguration = z.infer<typeof rtcConfigurationSchema>;
export type IceConfigurationData = z.infer<typeof iceConfigurationDataSchema>;
export type WebrtcSignalContext = z.infer<typeof webrtcSignalContextSchema>;
export type WebrtcOfferPayload = z.infer<typeof webrtcOfferPayloadSchema>;
export type WebrtcOfferRequest = z.infer<typeof webrtcOfferRequestSchema>;
export type WebrtcOfferAck = z.infer<typeof webrtcOfferAckSchema>;
export type WebrtcOfferBroadcast = z.infer<typeof webrtcOfferBroadcastSchema>;
export type WebrtcAnswerPayload = z.infer<typeof webrtcAnswerPayloadSchema>;
export type WebrtcAnswerRequest = z.infer<typeof webrtcAnswerRequestSchema>;
export type WebrtcAnswerAck = z.infer<typeof webrtcAnswerAckSchema>;
export type WebrtcAnswerBroadcast = z.infer<typeof webrtcAnswerBroadcastSchema>;
export type WebrtcAnswerAppliedPayload = z.infer<
  typeof webrtcAnswerAppliedPayloadSchema
>;
export type WebrtcAnswerAppliedRequest = z.infer<
  typeof webrtcAnswerAppliedRequestSchema
>;
export type WebrtcAnswerAppliedAck = z.infer<
  typeof webrtcAnswerAppliedAckSchema
>;
export type WebrtcIceCandidatePayload = z.infer<
  typeof webrtcIceCandidatePayloadSchema
>;
export type WebrtcIceCandidateRequest = z.infer<
  typeof webrtcIceCandidateRequestSchema
>;
export type WebrtcIceCandidateAck = z.infer<typeof webrtcIceCandidateAckSchema>;
export type WebrtcIceCandidateBroadcast = z.infer<
  typeof webrtcIceCandidateBroadcastSchema
>;
export type WebrtcIceRestartPayload = z.infer<
  typeof webrtcIceRestartPayloadSchema
>;
export type WebrtcIceRestartRequest = z.infer<
  typeof webrtcIceRestartRequestSchema
>;
export type WebrtcIceRestartAck = z.infer<typeof webrtcIceRestartAckSchema>;
export type WebrtcIceRestartBroadcast = z.infer<
  typeof webrtcIceRestartBroadcastSchema
>;
export type WebrtcRestartRequestedPayload = z.infer<
  typeof webrtcRestartRequestedPayloadSchema
>;
export type WebrtcRestartRequestedRequest = z.infer<
  typeof webrtcRestartRequestedRequestSchema
>;
export type WebrtcRestartRequestedAck = z.infer<
  typeof webrtcRestartRequestedAckSchema
>;
export type WebrtcRestartRequestedBroadcast = z.infer<
  typeof webrtcRestartRequestedBroadcastSchema
>;
export type WebrtcIceServersRefreshPayload = z.infer<
  typeof webrtcIceServersRefreshPayloadSchema
>;
export type WebrtcIceServersRefreshRequest = z.infer<
  typeof webrtcIceServersRefreshRequestSchema
>;
export type WebrtcIceServersRefreshAck = z.infer<
  typeof webrtcIceServersRefreshAckSchema
>;
export type NegotiationResetReason = z.infer<
  typeof negotiationResetReasonSchema
>;
export type WebrtcNegotiationResetPayload = z.infer<
  typeof webrtcNegotiationResetPayloadSchema
>;
export type WebrtcNegotiationResetBroadcast = z.infer<
  typeof webrtcNegotiationResetBroadcastSchema
>;
