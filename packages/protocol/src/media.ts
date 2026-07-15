import { z } from 'zod';

import {
  consumerIdSchema,
  createAckEnvelopeSchema,
  createRequestEnvelopeSchema,
  isoDateTimeSchema,
  leaseIdSchema,
  memberIdSchema,
  producerIdSchema,
  roomIdSchema,
  transportIdSchema,
} from './envelope.js';

export const mediaSourceSchema = z.enum(['microphone', 'screen']);
export const mediaKindSchema = z.enum(['audio', 'video']);
export const transportDirectionSchema = z.enum(['send', 'recv']);

const hasDuplicates = <Value>(values: readonly Value[]): boolean =>
  new Set(values).size !== values.length;

const mimeTypeMatchesKind = (
  mimeType: string,
  kind: z.infer<typeof mediaKindSchema>,
): boolean => mimeType.startsWith(`${kind}/`);

const rtpParameterValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
]);
const rtpParameterMapSchema = z.record(
  z.string().min(1).max(64),
  rtpParameterValueSchema,
);

export const rtcpFeedbackSchema = z
  .object({
    type: z.string().trim().min(1).max(64),
    parameter: z.string().trim().max(64).optional(),
  })
  .strict();

export const rtpCodecParametersSchema = z
  .object({
    mimeType: z.string().regex(/^(audio|video)\/[A-Za-z0-9.+-]+$/),
    payloadType: z.number().int().min(0).max(127),
    clockRate: z.number().int().positive().max(384_000),
    channels: z.number().int().positive().max(64).optional(),
    parameters: rtpParameterMapSchema,
    rtcpFeedback: z.array(rtcpFeedbackSchema).max(32),
  })
  .strict();

export const rtpHeaderExtensionParametersSchema = z
  .object({
    uri: z.string().trim().min(1).max(512),
    id: z.number().int().min(1).max(255),
    encrypt: z.boolean().optional(),
    parameters: rtpParameterMapSchema.optional(),
  })
  .strict();

export const rtpEncodingParametersSchema = z
  .object({
    ssrc: z.number().int().positive().max(0xffff_ffff).optional(),
    rid: z.string().trim().min(1).max(16).optional(),
    codecPayloadType: z.number().int().min(0).max(127).optional(),
    rtx: z
      .object({
        ssrc: z.number().int().positive().max(0xffff_ffff),
      })
      .strict()
      .optional(),
    dtx: z.boolean().optional(),
    scalabilityMode: z.string().trim().min(1).max(32).optional(),
    scaleResolutionDownBy: z.number().finite().min(1).max(16).optional(),
    maxBitrate: z.number().int().positive().max(100_000_000).optional(),
    maxFramerate: z.number().int().positive().max(240).optional(),
  })
  .strict();

export const rtpParametersSchema = z
  .object({
    mid: z.string().trim().min(1).max(32).optional(),
    codecs: z.array(rtpCodecParametersSchema).min(1).max(32),
    headerExtensions: z.array(rtpHeaderExtensionParametersSchema).max(32),
    encodings: z.array(rtpEncodingParametersSchema).min(1).max(8),
    rtcp: z
      .object({
        cname: z.string().trim().min(1).max(256).optional(),
        reducedSize: z.boolean().optional(),
        mux: z.boolean().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const payloadTypes = value.codecs.map((codec) => codec.payloadType);
    if (hasDuplicates(payloadTypes)) {
      context.addIssue({
        code: 'custom',
        path: ['codecs'],
        message: 'codec payload types must be unique',
      });
    }

    const headerExtensionIds = value.headerExtensions.map(
      (extension) => extension.id,
    );
    if (hasDuplicates(headerExtensionIds)) {
      context.addIssue({
        code: 'custom',
        path: ['headerExtensions'],
        message: 'header extension IDs must be unique',
      });
    }

    const declaredPayloadTypes = new Set(payloadTypes);
    const rids: string[] = [];
    const ssrcs: number[] = [];
    value.encodings.forEach((encoding, index) => {
      if (
        encoding.codecPayloadType !== undefined &&
        !declaredPayloadTypes.has(encoding.codecPayloadType)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['encodings', index, 'codecPayloadType'],
          message: 'must reference a declared codec payload type',
        });
      }
      if (encoding.rid !== undefined) {
        rids.push(encoding.rid);
      }
      if (encoding.ssrc !== undefined) {
        ssrcs.push(encoding.ssrc);
      }
      if (encoding.rtx?.ssrc !== undefined) {
        ssrcs.push(encoding.rtx.ssrc);
      }
    });

    if (hasDuplicates(rids)) {
      context.addIssue({
        code: 'custom',
        path: ['encodings'],
        message: 'encoding RIDs must be unique',
      });
    }
    if (hasDuplicates(ssrcs)) {
      context.addIssue({
        code: 'custom',
        path: ['encodings'],
        message: 'encoding and RTX SSRCs must be unique',
      });
    }
  });

export const rtpCodecCapabilitySchema = z
  .object({
    kind: mediaKindSchema,
    mimeType: z.string().regex(/^(audio|video)\/[A-Za-z0-9.+-]+$/),
    preferredPayloadType: z.number().int().min(0).max(127).optional(),
    clockRate: z.number().int().positive().max(384_000),
    channels: z.number().int().positive().max(64).optional(),
    parameters: rtpParameterMapSchema,
    rtcpFeedback: z.array(rtcpFeedbackSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (!mimeTypeMatchesKind(value.mimeType, value.kind)) {
      context.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: 'codec MIME type must match its media kind',
      });
    }
  });

export const rtpHeaderExtensionCapabilitySchema = z
  .object({
    kind: mediaKindSchema,
    uri: z.string().trim().min(1).max(512),
    preferredId: z.number().int().min(1).max(255),
    preferredEncrypt: z.boolean().optional(),
    direction: z
      .enum(['sendrecv', 'sendonly', 'recvonly', 'inactive'])
      .optional(),
  })
  .strict();

export const rtpCapabilitiesSchema = z
  .object({
    codecs: z.array(rtpCodecCapabilitySchema).min(1).max(32),
    headerExtensions: z.array(rtpHeaderExtensionCapabilitySchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const preferredHeaderExtensionKeys = value.headerExtensions.map(
      (extension) => `${extension.kind}:${extension.preferredId}`,
    );
    if (hasDuplicates(preferredHeaderExtensionKeys)) {
      context.addIssue({
        code: 'custom',
        path: ['headerExtensions'],
        message: 'preferred header extension IDs must be unique per media kind',
      });
    }
  });

const dtlsFingerprintByteLengths = {
  'sha-1': 20,
  'sha-224': 28,
  'sha-256': 32,
  'sha-384': 48,
  'sha-512': 64,
} as const;

export const dtlsFingerprintSchema = z
  .object({
    algorithm: z.enum(['sha-1', 'sha-224', 'sha-256', 'sha-384', 'sha-512']),
    value: z.string().trim().min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedByteLength = dtlsFingerprintByteLengths[value.algorithm];
    const digestBytes = value.value.split(':');
    if (
      digestBytes.length !== expectedByteLength ||
      digestBytes.some((byte) => !/^[0-9a-f]{2}$/i.test(byte))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `must be a ${expectedByteLength}-byte colon-separated hexadecimal digest`,
      });
    }
  });
export const dtlsParametersSchema = z
  .object({
    role: z.enum(['auto', 'client', 'server']).optional(),
    fingerprints: z.array(dtlsFingerprintSchema).min(1).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const algorithms = value.fingerprints.map(
      (fingerprintValue) => fingerprintValue.algorithm,
    );
    if (hasDuplicates(algorithms)) {
      context.addIssue({
        code: 'custom',
        path: ['fingerprints'],
        message: 'fingerprint algorithms must be unique',
      });
    }
  });

export const iceParametersSchema = z
  .object({
    usernameFragment: z.string().trim().min(1).max(256),
    password: z.string().trim().min(1).max(256),
    iceLite: z.boolean().optional(),
  })
  .strict();
export const iceCandidateSchema = z
  .object({
    foundation: z.string().trim().min(1).max(32),
    priority: z.number().int().min(0).max(0xffff_ffff),
    ip: z.union([z.ipv4(), z.ipv6()]),
    protocol: z.enum(['udp', 'tcp']),
    port: z.number().int().min(1).max(65_535),
    type: z.enum(['host', 'srflx', 'prflx', 'relay']),
    tcpType: z.enum(['active', 'passive', 'so']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.protocol === 'tcp' && value.tcpType === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['tcpType'],
        message: 'is required for TCP candidates',
      });
    }
    if (value.protocol === 'udp' && value.tcpType !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['tcpType'],
        message: 'is not allowed for UDP candidates',
      });
    }
  });

export const transportCreatePayloadSchema = z
  .object({ roomId: roomIdSchema, direction: transportDirectionSchema })
  .strict();
export const transportCreateRequestSchema = createRequestEnvelopeSchema(
  'transport.create',
  transportCreatePayloadSchema,
);
export const transportCreateAckDataSchema = z
  .object({
    roomId: roomIdSchema,
    transportId: transportIdSchema,
    direction: transportDirectionSchema,
    iceParameters: iceParametersSchema,
    iceCandidates: z.array(iceCandidateSchema).min(1).max(32),
    dtlsParameters: dtlsParametersSchema,
  })
  .strict();
export const transportCreateAckSchema = createAckEnvelopeSchema(
  'transport.create',
  transportCreateAckDataSchema,
);

export const transportConnectPayloadSchema = z
  .object({
    roomId: roomIdSchema,
    transportId: transportIdSchema,
    dtlsParameters: dtlsParametersSchema,
  })
  .strict();
export const transportConnectRequestSchema = createRequestEnvelopeSchema(
  'transport.connect',
  transportConnectPayloadSchema,
);
export const transportConnectAckSchema = createAckEnvelopeSchema(
  'transport.connect',
  z.object({}).strict(),
);

export const producerCreatePayloadSchema = z
  .object({
    roomId: roomIdSchema,
    transportId: transportIdSchema,
    source: mediaSourceSchema,
    kind: mediaKindSchema,
    rtpParameters: rtpParametersSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const validPair =
      (value.source === 'microphone' && value.kind === 'audio') ||
      (value.source === 'screen' && value.kind === 'video');

    if (!validPair) {
      context.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'microphone requires audio and screen requires video',
      });
    }

    value.rtpParameters.codecs.forEach((codec, index) => {
      if (!mimeTypeMatchesKind(codec.mimeType, value.kind)) {
        context.addIssue({
          code: 'custom',
          path: ['rtpParameters', 'codecs', index, 'mimeType'],
          message: 'codec MIME type must match the producer kind',
        });
      }
    });
  });
export const producerCreateRequestSchema = createRequestEnvelopeSchema(
  'producer.create',
  producerCreatePayloadSchema,
);
export const producerCreateAckDataSchema = z
  .object({ producerId: producerIdSchema })
  .strict();
export const producerCreateAckSchema = createAckEnvelopeSchema(
  'producer.create',
  producerCreateAckDataSchema,
);

export const producerClosePayloadSchema = z
  .object({ roomId: roomIdSchema, producerId: producerIdSchema })
  .strict();
export const producerCloseRequestSchema = createRequestEnvelopeSchema(
  'producer.close',
  producerClosePayloadSchema,
);
export const producerCloseAckSchema = createAckEnvelopeSchema(
  'producer.close',
  z.object({}).strict(),
);

export const consumerCreatePayloadSchema = z
  .object({
    roomId: roomIdSchema,
    transportId: transportIdSchema,
    producerId: producerIdSchema,
    rtpCapabilities: rtpCapabilitiesSchema,
  })
  .strict();
export const consumerCreateRequestSchema = createRequestEnvelopeSchema(
  'consumer.create',
  consumerCreatePayloadSchema,
);
export const consumerCreateAckDataSchema = z
  .object({
    consumerId: consumerIdSchema,
    producerId: producerIdSchema,
    kind: mediaKindSchema,
    rtpParameters: rtpParametersSchema,
  })
  .strict()
  .superRefine((value, context) => {
    value.rtpParameters.codecs.forEach((codec, index) => {
      if (!mimeTypeMatchesKind(codec.mimeType, value.kind)) {
        context.addIssue({
          code: 'custom',
          path: ['rtpParameters', 'codecs', index, 'mimeType'],
          message: 'codec MIME type must match the consumer kind',
        });
      }
    });
  });
export const consumerCreateAckSchema = createAckEnvelopeSchema(
  'consumer.create',
  consumerCreateAckDataSchema,
);

export const consumerResumePayloadSchema = z
  .object({ roomId: roomIdSchema, consumerId: consumerIdSchema })
  .strict();
export const consumerResumeRequestSchema = createRequestEnvelopeSchema(
  'consumer.resume',
  consumerResumePayloadSchema,
);
export const consumerResumeAckSchema = createAckEnvelopeSchema(
  'consumer.resume',
  z.object({}).strict(),
);

export const screenLeaseSchema = z
  .object({
    roomId: roomIdSchema,
    leaseId: leaseIdSchema,
    holderId: memberIdSchema,
    expiresAt: isoDateTimeSchema,
  })
  .strict();

export const screenAcquirePayloadSchema = z
  .object({ roomId: roomIdSchema })
  .strict();
export const screenAcquireRequestSchema = createRequestEnvelopeSchema(
  'screen.acquire',
  screenAcquirePayloadSchema,
);
export const screenAcquireAckSchema = createAckEnvelopeSchema(
  'screen.acquire',
  z.object({ lease: screenLeaseSchema }).strict(),
);

export const screenRenewPayloadSchema = z
  .object({ roomId: roomIdSchema, leaseId: leaseIdSchema })
  .strict();
export const screenRenewRequestSchema = createRequestEnvelopeSchema(
  'screen.renew',
  screenRenewPayloadSchema,
);
export const screenRenewAckSchema = createAckEnvelopeSchema(
  'screen.renew',
  z.object({ lease: screenLeaseSchema }).strict(),
);

export const screenReleasePayloadSchema = z
  .object({ roomId: roomIdSchema, leaseId: leaseIdSchema })
  .strict();
export const screenReleaseRequestSchema = createRequestEnvelopeSchema(
  'screen.release',
  screenReleasePayloadSchema,
);
export const screenReleaseAckSchema = createAckEnvelopeSchema(
  'screen.release',
  z.object({}).strict(),
);

export const screenTargetBitrateSchema = z
  .number()
  .int()
  .min(1_000_000)
  .max(10_000_000);
export const screenSetTargetBitratePayloadSchema = z
  .object({
    roomId: roomIdSchema,
    leaseId: leaseIdSchema,
    bitrate: screenTargetBitrateSchema,
  })
  .strict();
export const screenSetTargetBitrateRequestSchema = createRequestEnvelopeSchema(
  'screen.setTargetBitrate',
  screenSetTargetBitratePayloadSchema,
);
export const screenSetTargetBitrateAckSchema = createAckEnvelopeSchema(
  'screen.setTargetBitrate',
  z.object({ bitrate: screenTargetBitrateSchema }).strict(),
);

export type MediaSource = z.infer<typeof mediaSourceSchema>;
export type TransportDirection = z.infer<typeof transportDirectionSchema>;
export type TransportCreateRequest = z.infer<
  typeof transportCreateRequestSchema
>;
export type TransportConnectRequest = z.infer<
  typeof transportConnectRequestSchema
>;
export type ProducerCreateRequest = z.infer<typeof producerCreateRequestSchema>;
export type ProducerCloseRequest = z.infer<typeof producerCloseRequestSchema>;
export type ConsumerCreateRequest = z.infer<typeof consumerCreateRequestSchema>;
export type ConsumerResumeRequest = z.infer<typeof consumerResumeRequestSchema>;
export type ScreenLease = z.infer<typeof screenLeaseSchema>;
export type ScreenAcquireRequest = z.infer<typeof screenAcquireRequestSchema>;
export type ScreenRenewRequest = z.infer<typeof screenRenewRequestSchema>;
export type ScreenReleaseRequest = z.infer<typeof screenReleaseRequestSchema>;
export type ScreenSetTargetBitrateRequest = z.infer<
  typeof screenSetTargetBitrateRequestSchema
>;
export type TransportCreateAck = z.infer<typeof transportCreateAckSchema>;
export type TransportConnectAck = z.infer<typeof transportConnectAckSchema>;
export type ProducerCreateAck = z.infer<typeof producerCreateAckSchema>;
export type ProducerCloseAck = z.infer<typeof producerCloseAckSchema>;
export type ConsumerCreateAck = z.infer<typeof consumerCreateAckSchema>;
export type ConsumerResumeAck = z.infer<typeof consumerResumeAckSchema>;
export type ScreenAcquireAck = z.infer<typeof screenAcquireAckSchema>;
export type ScreenRenewAck = z.infer<typeof screenRenewAckSchema>;
export type ScreenReleaseAck = z.infer<typeof screenReleaseAckSchema>;
export type ScreenSetTargetBitrateAck = z.infer<
  typeof screenSetTargetBitrateAckSchema
>;
