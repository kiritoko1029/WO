import { describe, expect, test } from 'vitest';

import {
  P2P_MEDIA_PLAN,
  PROTOCOL_VERSION,
  ackEnvelopeSchema,
  authLoginBodySchema,
  authLoginResponseSchema,
  authLogoutBodySchema,
  authLogoutResponseSchema,
  authRefreshBodySchema,
  authRefreshResponseSchema,
  authRefreshRequestSchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  broadcastEnvelopeSchema,
  connectionEpochSchema,
  connectionIdSchema,
  consumerIdSchema,
  consumerCreateAckDataSchema,
  dtlsFingerprintSchema,
  dtlsParametersSchema,
  eventIdSchema,
  iceCandidateSchema,
  iceServerUrlSchema,
  inboundEnvelopeSchema,
  leaseIdSchema,
  memberIdSchema,
  negotiationIdSchema,
  p2pAckEnvelopeSchema,
  p2pBroadcastEnvelopeSchema,
  p2pOutboundResponseSchema,
  p2pRequestEnvelopeSchema,
  parseAuthenticatedAuthResponse,
  peerReadyBroadcastSchema,
  protocolErrorResponseSchema,
  producerCreatePayloadSchema,
  producerIdSchema,
  publicIceServerSchema,
  requestIdSchema,
  roomCodeSchema,
  roomIdSchema,
  roomRoleSchema,
  roomStateSchema,
  rtpCapabilitiesSchema,
  rtpParametersSchema,
  screenBitrateRequestSchema,
  screenLeaseSchema,
  screenOwnerChangedBroadcastSchema,
  screenSetTargetBitrateRequestSchema,
  signalTicketResponseSchema,
  transportCreateRequestSchema,
  transportIdSchema,
  userIdSchema,
  iceCandidateInitSchema,
  type AuthLoginResponse,
  type AuthRefreshResponse,
  type AuthRegisterResponse,
  type CreatorActiveRoomSession,
  type CreatorWaitingRoomSession,
  type DisplayName,
  type Email,
  type IceServerUrl,
  type JoinerActiveRoomSession,
  type NegotiationResetReason,
  type P2pRequestEnvelope,
  type P2pOutboundResponse,
  type P2pRoomJoinPayload,
  type PeerJoinedBroadcast,
  type PeerJoinedPayload,
  type PeerLeftBroadcast,
  type PeerLeftPayload,
  type PeerLeftReason,
  type PeerReadyBroadcast,
  type PeerReadyBroadcastPayload,
  type PeerReadyPayload,
  type Password,
  type RoomActiveState,
  type RoomClosedBroadcast,
  type RoomClosedPayload,
  type RoomClosedReason,
  type RoomCreateAckData,
  type RoomCreatePayload,
  type RoomEndPayload,
  type RoomResumePayload,
  type ScreenBitrateBroadcast,
  type ScreenBitratePayload,
  type ScreenOwnerChangedPayload,
  type SignalTicketResponse,
  type WebrtcAnswerAck,
  type WebrtcAnswerBroadcast,
  type WebrtcAnswerPayload,
  type WebrtcIceCandidateAck,
  type WebrtcIceCandidateBroadcast,
  type WebrtcIceCandidatePayload,
  type WebrtcIceRestartAck,
  type WebrtcIceRestartBroadcast,
  type WebrtcIceRestartPayload,
  type WebrtcIceServersRefreshAck,
  type WebrtcIceServersRefreshPayload,
  type WebrtcNegotiationResetBroadcast,
  type WebrtcNegotiationResetPayload,
  type WebrtcOfferAck,
  type WebrtcOfferBroadcast,
  type WebrtcOfferPayload,
  type WebrtcRestartRequestedAck,
  type WebrtcRestartRequestedBroadcast,
  type WebrtcRestartRequestedPayload,
  type WebrtcSignalContext,
  type AckEnvelope,
  type ConsumerId,
  type ErrorCode,
  type EventId,
  type LeaseId,
  type MemberId,
  type ProducerId,
  type ProtocolErrorResponse,
  type RequestId,
  type RoomId,
  type TransportId,
  type UserId,
} from '../src/index.js';

type PublicP2pSchemaTypeExports = readonly [
  Email,
  Password,
  DisplayName,
  AuthRegisterResponse,
  AuthLoginResponse,
  AuthRefreshResponse,
  RoomActiveState,
  CreatorWaitingRoomSession,
  CreatorActiveRoomSession,
  JoinerActiveRoomSession,
  RoomCreatePayload,
  RoomCreateAckData,
  P2pRoomJoinPayload,
  RoomResumePayload,
  RoomEndPayload,
  PeerReadyPayload,
  PeerJoinedPayload,
  PeerJoinedBroadcast,
  PeerLeftReason,
  PeerLeftPayload,
  PeerLeftBroadcast,
  PeerReadyBroadcastPayload,
  PeerReadyBroadcast,
  RoomClosedReason,
  RoomClosedPayload,
  RoomClosedBroadcast,
  IceServerUrl,
  WebrtcSignalContext,
  WebrtcOfferPayload,
  WebrtcOfferAck,
  WebrtcOfferBroadcast,
  WebrtcAnswerPayload,
  WebrtcAnswerAck,
  WebrtcAnswerBroadcast,
  WebrtcIceCandidatePayload,
  WebrtcIceCandidateAck,
  WebrtcIceCandidateBroadcast,
  WebrtcIceRestartPayload,
  WebrtcIceRestartAck,
  WebrtcIceRestartBroadcast,
  WebrtcRestartRequestedPayload,
  WebrtcRestartRequestedAck,
  WebrtcRestartRequestedBroadcast,
  WebrtcIceServersRefreshPayload,
  WebrtcIceServersRefreshAck,
  NegotiationResetReason,
  WebrtcNegotiationResetPayload,
  WebrtcNegotiationResetBroadcast,
  ScreenBitratePayload,
  ScreenBitrateBroadcast,
  ScreenOwnerChangedPayload,
  ProtocolErrorResponse,
  P2pOutboundResponse,
  SignalTicketResponse,
];

const preservePublicP2pSchemaTypes = (
  value: PublicP2pSchemaTypeExports | undefined,
) => value;

const fingerprint = (byteLength: number, byte = 'AA') =>
  Array.from({ length: byteLength }, () => byte).join(':');

const request = (type: string, payload: Record<string, unknown>) => ({
  version: 1,
  requestId: 'request-1',
  type,
  payload,
});

const validDtlsParameters = {
  role: 'auto',
  fingerprints: [
    {
      algorithm: 'sha-256',
      value: fingerprint(32),
    },
  ],
};

const validAudioRtpParameters = {
  mid: '0',
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: 111,
      clockRate: 48_000,
      channels: 2,
      parameters: { useinbandfec: 1 },
      rtcpFeedback: [],
    },
  ],
  headerExtensions: [],
  encodings: [{ ssrc: 1_234_567 }],
  rtcp: { cname: 'audio-cname', reducedSize: true },
};

const validRtpCapabilities = {
  codecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      preferredPayloadType: 111,
      clockRate: 48_000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  headerExtensions: [],
};

describe('RTC request envelopes', () => {
  test('uses protocol version 1 and rejects another version', () => {
    expect(PROTOCOL_VERSION).toBe(1);

    const valid = request('auth.refresh', { refreshToken: 'refresh-token' });
    expect(inboundEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(
      inboundEnvelopeSchema.safeParse({ ...valid, version: 2 }).success,
    ).toBe(false);
  });

  test('accepts every supported request with a strict payload', () => {
    const requests = [
      request('auth.refresh', { refreshToken: 'refresh-token' }),
      request('room.join', { roomId: 'room-1' }),
      request('room.leave', { roomId: 'room-1' }),
      request('transport.create', { roomId: 'room-1', direction: 'send' }),
      request('transport.connect', {
        roomId: 'room-1',
        transportId: 'transport-1',
        dtlsParameters: validDtlsParameters,
      }),
      request('producer.create', {
        roomId: 'room-1',
        transportId: 'transport-1',
        source: 'microphone',
        kind: 'audio',
        rtpParameters: validAudioRtpParameters,
      }),
      request('producer.close', {
        roomId: 'room-1',
        producerId: 'producer-1',
      }),
      request('consumer.create', {
        roomId: 'room-1',
        transportId: 'transport-1',
        producerId: 'producer-1',
        rtpCapabilities: validRtpCapabilities,
      }),
      request('consumer.resume', {
        roomId: 'room-1',
        consumerId: 'consumer-1',
      }),
      request('screen.acquire', { roomId: 'room-1' }),
      request('screen.renew', { roomId: 'room-1', leaseId: 'lease-1' }),
      request('screen.release', { roomId: 'room-1', leaseId: 'lease-1' }),
      request('screen.setTargetBitrate', {
        roomId: 'room-1',
        leaseId: 'lease-1',
        bitrate: 6_000_000,
      }),
    ];

    for (const value of requests) {
      expect(inboundEnvelopeSchema.safeParse(value), value.type).toMatchObject({
        success: true,
      });
    }
  });

  test('requires all inbound envelope fields', () => {
    const valid = request('room.join', { roomId: 'room-1' });

    for (const field of ['version', 'requestId', 'type', 'payload']) {
      const incomplete = { ...valid };
      delete incomplete[field as keyof typeof incomplete];
      expect(inboundEnvelopeSchema.safeParse(incomplete).success, field).toBe(
        false,
      );
    }
  });

  test('rejects unknown envelope, payload, and nested fields', () => {
    expect(
      inboundEnvelopeSchema.safeParse({
        ...request('room.join', { roomId: 'room-1' }),
        unexpected: true,
      }).success,
    ).toBe(false);

    expect(
      inboundEnvelopeSchema.safeParse(
        request('room.join', { roomId: 'room-1', unexpected: true }),
      ).success,
    ).toBe(false);

    expect(
      inboundEnvelopeSchema.safeParse(
        request('transport.connect', {
          roomId: 'room-1',
          transportId: 'transport-1',
          dtlsParameters: { ...validDtlsParameters, unexpected: true },
        }),
      ).success,
    ).toBe(false);

    expect(
      inboundEnvelopeSchema.safeParse(
        request('producer.create', {
          roomId: 'room-1',
          transportId: 'transport-1',
          source: 'microphone',
          kind: 'audio',
          rtpParameters: {
            ...validAudioRtpParameters,
            encodings: [{ rtx: { ssrc: 0x1_0000_0000 } }],
          },
        }),
      ).success,
    ).toBe(false);
  });

  test('rejects empty and overlong reusable identifiers', () => {
    expect(requestIdSchema.safeParse('').success).toBe(false);
    expect(requestIdSchema.safeParse('x'.padStart(128)).success).toBe(true);
    expect(requestIdSchema.safeParse('x'.padStart(129)).success).toBe(false);
    expect(requestIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(
      inboundEnvelopeSchema.safeParse(
        request('room.join', { roomId: 'x'.repeat(129) }),
      ).success,
    ).toBe(false);
  });

  test('exposes reusable identifiers as distinct nominal types', () => {
    const requestId = requestIdSchema.parse('request-1');
    const eventId = eventIdSchema.parse('event-1');
    const roomId = roomIdSchema.parse('room-1');
    const memberId = memberIdSchema.parse('member-1');
    const transportId = transportIdSchema.parse('transport-1');
    const producerId = producerIdSchema.parse('producer-1');
    const consumerId = consumerIdSchema.parse('consumer-1');
    const leaseId = leaseIdSchema.parse('lease-1');

    const acceptsRequestId = (value: RequestId) => value;
    const acceptsEventId = (value: EventId) => value;
    const acceptsRoomId = (value: RoomId) => value;
    const acceptsMemberId = (value: MemberId) => value;
    const acceptsTransportId = (value: TransportId) => value;
    const acceptsProducerId = (value: ProducerId) => value;
    const acceptsConsumerId = (value: ConsumerId) => value;
    const acceptsLeaseId = (value: LeaseId) => value;

    expect(acceptsRequestId(requestId)).toBe('request-1');
    expect(acceptsEventId(eventId)).toBe('event-1');
    expect(acceptsRoomId(roomId)).toBe('room-1');
    expect(acceptsMemberId(memberId)).toBe('member-1');
    expect(acceptsTransportId(transportId)).toBe('transport-1');
    expect(acceptsProducerId(producerId)).toBe('producer-1');
    expect(acceptsConsumerId(consumerId)).toBe('consumer-1');
    expect(acceptsLeaseId(leaseId)).toBe('lease-1');

    // @ts-expect-error Event IDs cannot be used as request IDs.
    acceptsRequestId(eventId);
    // @ts-expect-error Room IDs cannot be used as event IDs.
    acceptsEventId(roomId);
    // @ts-expect-error Member IDs cannot be used as room IDs.
    acceptsRoomId(memberId);
    // @ts-expect-error Transport IDs cannot be used as member IDs.
    acceptsMemberId(transportId);
    // @ts-expect-error Producer IDs cannot be used as transport IDs.
    acceptsTransportId(producerId);
    // @ts-expect-error Consumer IDs cannot be used as producer IDs.
    acceptsProducerId(consumerId);
    // @ts-expect-error Lease IDs cannot be used as consumer IDs.
    acceptsConsumerId(leaseId);
    // @ts-expect-error Request IDs cannot be used as lease IDs.
    acceptsLeaseId(requestId);
  });

  test('restricts transport direction to send or recv', () => {
    expect(
      inboundEnvelopeSchema.safeParse(
        request('transport.create', {
          roomId: 'room-1',
          direction: 'publish',
        }),
      ).success,
    ).toBe(false);
  });

  test('restricts producer source and enforces source-kind pairing', () => {
    expect(
      inboundEnvelopeSchema.safeParse(
        request('producer.create', {
          roomId: 'room-1',
          transportId: 'transport-1',
          source: 'camera',
          kind: 'video',
          rtpParameters: validAudioRtpParameters,
        }),
      ).success,
    ).toBe(false);

    expect(
      inboundEnvelopeSchema.safeParse(
        request('producer.create', {
          roomId: 'room-1',
          transportId: 'transport-1',
          source: 'screen',
          kind: 'audio',
          rtpParameters: validAudioRtpParameters,
        }),
      ).success,
    ).toBe(false);
  });

  test('requires an auth refresh token and rejects unknown auth fields', () => {
    expect(
      authRefreshRequestSchema.safeParse(
        request('auth.refresh', { refreshToken: '' }),
      ).success,
    ).toBe(false);
    expect(
      authRefreshRequestSchema.safeParse(
        request('auth.refresh', {
          refreshToken: 'refresh-token',
          accessToken: 'not-accepted',
        }),
      ).success,
    ).toBe(false);
  });
});

describe('media semantic validation', () => {
  test('matches producer, consumer, and capability kinds to codec MIME types', () => {
    const videoCodec = {
      ...validAudioRtpParameters.codecs[0],
      mimeType: 'video/VP8',
      payloadType: 96,
      clockRate: 90_000,
    };
    const videoRtpParameters = {
      ...validAudioRtpParameters,
      codecs: [videoCodec],
    };

    expect(
      producerCreatePayloadSchema.safeParse({
        roomId: 'room-1',
        transportId: 'transport-1',
        source: 'microphone',
        kind: 'audio',
        rtpParameters: videoRtpParameters,
      }).success,
    ).toBe(false);
    expect(
      consumerCreateAckDataSchema.safeParse({
        consumerId: 'consumer-1',
        producerId: 'producer-1',
        kind: 'video',
        rtpParameters: validAudioRtpParameters,
      }).success,
    ).toBe(false);
    expect(
      rtpCapabilitiesSchema.safeParse({
        ...validRtpCapabilities,
        codecs: [
          {
            ...validRtpCapabilities.codecs[0],
            kind: 'audio',
            mimeType: 'video/VP8',
            preferredPayloadType: 96,
            clockRate: 90_000,
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      producerCreatePayloadSchema.safeParse({
        roomId: 'room-1',
        transportId: 'transport-1',
        source: 'microphone',
        kind: 'audio',
        rtpParameters: validAudioRtpParameters,
      }).success,
    ).toBe(true);
  });

  test('requires unique codec payload types and header extension IDs', () => {
    const duplicatePayloadTypes = {
      ...validAudioRtpParameters,
      codecs: [
        validAudioRtpParameters.codecs[0],
        {
          ...validAudioRtpParameters.codecs[0],
          mimeType: 'audio/PCMU',
          clockRate: 8_000,
        },
      ],
    };
    const duplicateHeaderIds = {
      ...validAudioRtpParameters,
      headerExtensions: [
        { uri: 'urn:example:audio-level', id: 1 },
        { uri: 'urn:example:mid', id: 1 },
      ],
    };
    const duplicateCapabilityIds = {
      ...validRtpCapabilities,
      headerExtensions: [
        {
          kind: 'audio',
          uri: 'urn:example:audio-level',
          preferredId: 1,
        },
        { kind: 'audio', uri: 'urn:example:mid', preferredId: 1 },
      ],
    };

    expect(rtpParametersSchema.safeParse(duplicatePayloadTypes).success).toBe(
      false,
    );
    expect(rtpParametersSchema.safeParse(duplicateHeaderIds).success).toBe(
      false,
    );
    expect(
      rtpCapabilitiesSchema.safeParse(duplicateCapabilityIds).success,
    ).toBe(false);
  });

  test('allows capability header IDs to repeat across media kinds', () => {
    expect(
      rtpCapabilitiesSchema.safeParse({
        codecs: [
          validRtpCapabilities.codecs[0],
          {
            kind: 'video',
            mimeType: 'video/VP8',
            preferredPayloadType: 96,
            clockRate: 90_000,
            parameters: {},
            rtcpFeedback: [],
          },
        ],
        headerExtensions: [
          {
            kind: 'audio',
            uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
            preferredId: 1,
          },
          {
            kind: 'video',
            uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',
            preferredId: 1,
          },
        ],
      }).success,
    ).toBe(true);
  });

  test('allows CN capabilities with different clock rates to reuse payload type 13', () => {
    const comfortNoiseCapability = (clockRate: number) => ({
      kind: 'audio' as const,
      mimeType: 'audio/CN',
      preferredPayloadType: 13,
      clockRate,
      parameters: {},
      rtcpFeedback: [],
    });

    expect(
      rtpCapabilitiesSchema.safeParse({
        codecs: [
          comfortNoiseCapability(32_000),
          comfortNoiseCapability(16_000),
          comfortNoiseCapability(8_000),
        ],
        headerExtensions: [],
      }).success,
    ).toBe(true);
  });

  test('requires encoding codec payload types to reference a declared codec', () => {
    expect(
      rtpParametersSchema.safeParse({
        ...validAudioRtpParameters,
        encodings: [{ ssrc: 1_234_567, codecPayloadType: 112 }],
      }).success,
    ).toBe(false);
    expect(
      rtpParametersSchema.safeParse({
        ...validAudioRtpParameters,
        encodings: [{ ssrc: 1_234_567, codecPayloadType: 111 }],
      }).success,
    ).toBe(true);
  });

  test('requires unique encoding RIDs and SSRCs, including RTX SSRCs', () => {
    expect(
      rtpParametersSchema.safeParse({
        ...validAudioRtpParameters,
        encodings: [
          { rid: 'low', ssrc: 1, rtx: { ssrc: 2 } },
          { rid: 'low', ssrc: 3, rtx: { ssrc: 4 } },
        ],
      }).success,
    ).toBe(false);
    expect(
      rtpParametersSchema.safeParse({
        ...validAudioRtpParameters,
        encodings: [
          { rid: 'low', ssrc: 1, rtx: { ssrc: 2 } },
          { rid: 'high', ssrc: 2, rtx: { ssrc: 4 } },
        ],
      }).success,
    ).toBe(false);
    expect(
      rtpParametersSchema.safeParse({
        ...validAudioRtpParameters,
        encodings: [
          { rid: 'low', ssrc: 1, rtx: { ssrc: 2 } },
          { rid: 'high', ssrc: 3, rtx: { ssrc: 4 } },
        ],
      }).success,
    ).toBe(true);
  });

  test('validates DTLS fingerprint format and digest length by algorithm', () => {
    for (const [algorithm, byteLength] of [
      ['sha-1', 20],
      ['sha-224', 28],
      ['sha-256', 32],
      ['sha-384', 48],
      ['sha-512', 64],
    ] as const) {
      expect(
        dtlsFingerprintSchema.safeParse({
          algorithm,
          value: fingerprint(byteLength),
        }).success,
      ).toBe(true);
      expect(
        dtlsFingerprintSchema.safeParse({
          algorithm,
          value: fingerprint(byteLength - 1),
        }).success,
      ).toBe(false);
    }

    expect(
      dtlsFingerprintSchema.safeParse({
        algorithm: 'sha-256',
        value: fingerprint(32).replace('AA', 'GG'),
      }).success,
    ).toBe(false);
    expect(
      dtlsFingerprintSchema.safeParse({
        algorithm: 'sha-256',
        value: fingerprint(32).replaceAll(':', ''),
      }).success,
    ).toBe(false);
  });

  test('rejects duplicate DTLS fingerprint algorithms', () => {
    expect(
      dtlsParametersSchema.safeParse({
        role: 'auto',
        fingerprints: [
          { algorithm: 'sha-256', value: fingerprint(32, 'AA') },
          { algorithm: 'sha-256', value: fingerprint(32, 'BB') },
        ],
      }).success,
    ).toBe(false);
    expect(
      dtlsParametersSchema.safeParse({
        role: 'auto',
        fingerprints: [
          { algorithm: 'sha-256', value: fingerprint(32) },
          { algorithm: 'sha-384', value: fingerprint(48) },
        ],
      }).success,
    ).toBe(true);
  });

  test('requires ICE candidate addresses to be IP literals', () => {
    const candidate = {
      foundation: '1',
      priority: 2_130_706_431,
      protocol: 'udp',
      port: 40_000,
      type: 'host',
    };

    expect(
      iceCandidateSchema.safeParse({ ...candidate, ip: '1.1.1.1' }).success,
    ).toBe(true);
    expect(
      iceCandidateSchema.safeParse({ ...candidate, ip: '2001:db8::1' }).success,
    ).toBe(true);
    expect(
      iceCandidateSchema.safeParse({ ...candidate, ip: 'media.example.com' })
        .success,
    ).toBe(false);
    expect(
      iceCandidateSchema.safeParse({ ...candidate, ip: '999.1.1.1' }).success,
    ).toBe(false);
  });

  test('requires tcpType for TCP candidates and forbids it for UDP', () => {
    const candidate = {
      foundation: '1',
      priority: 2_130_706_431,
      ip: '1.1.1.1',
      port: 40_000,
      type: 'host',
    };

    expect(
      iceCandidateSchema.safeParse({
        ...candidate,
        protocol: 'tcp',
      }).success,
    ).toBe(false);
    expect(
      iceCandidateSchema.safeParse({
        ...candidate,
        protocol: 'tcp',
        tcpType: 'passive',
      }).success,
    ).toBe(true);
    expect(
      iceCandidateSchema.safeParse({
        ...candidate,
        protocol: 'udp',
        tcpType: 'passive',
      }).success,
    ).toBe(false);
    expect(
      iceCandidateSchema.safeParse({
        ...candidate,
        protocol: 'udp',
      }).success,
    ).toBe(true);
  });
});

describe('screen sharing protocol', () => {
  test.each([1_000_000, 20_000_000])(
    'accepts target bitrate boundary %i',
    (bitrate) => {
      expect(
        screenSetTargetBitrateRequestSchema.safeParse(
          request('screen.setTargetBitrate', {
            roomId: 'room-1',
            leaseId: 'lease-1',
            bitrate,
          }),
        ).success,
      ).toBe(true);
    },
  );

  test.each([999_999, 20_000_001, 1_500_000.5])(
    'rejects invalid target bitrate %s',
    (bitrate) => {
      expect(
        screenSetTargetBitrateRequestSchema.safeParse(
          request('screen.setTargetBitrate', {
            roomId: 'room-1',
            leaseId: 'lease-1',
            bitrate,
          }),
        ).success,
      ).toBe(false);
    },
  );

  test('requires strict room and lease identifiers for a screen lease', () => {
    const lease = {
      roomId: 'room-1',
      leaseId: 'lease-1',
      holderId: 'member-1',
      expiresAt: '2026-07-15T12:00:00.000Z',
    };

    expect(screenLeaseSchema.safeParse(lease).success).toBe(true);
    expect(
      screenLeaseSchema.safeParse({ ...lease, roomId: undefined }).success,
    ).toBe(false);
    expect(
      screenLeaseSchema.safeParse({ ...lease, leaseId: undefined }).success,
    ).toBe(false);
    expect(
      screenLeaseSchema.safeParse({ ...lease, internalState: {} }).success,
    ).toBe(false);
  });
});

describe('broadcast and acknowledgement envelopes', () => {
  test('accepts strict room member joined and left broadcasts', () => {
    const joinedEventId: EventId = eventIdSchema.parse('event-1');
    const joined = {
      version: 1,
      eventId: joinedEventId,
      type: 'room.member.joined',
      payload: {
        roomId: 'room-1',
        member: { memberId: 'member-1', displayName: 'Ada' },
      },
    };
    const left = {
      version: 1,
      eventId: 'event-2',
      type: 'room.member.left',
      payload: {
        roomId: 'room-1',
        memberId: 'member-1',
        reason: 'left',
      },
    };

    expect(broadcastEnvelopeSchema.safeParse(joined).success).toBe(true);
    expect(broadcastEnvelopeSchema.safeParse(left).success).toBe(true);
    expect(
      broadcastEnvelopeSchema.safeParse({ ...joined, extra: true }).success,
    ).toBe(false);
  });

  test('accepts discriminated success and stable failure acknowledgements', () => {
    const success = {
      version: 1,
      requestId: 'request-1',
      type: 'screen.acquire.ack',
      payload: {
        ok: true,
        data: {
          lease: {
            roomId: 'room-1',
            leaseId: 'lease-1',
            holderId: 'member-1',
            expiresAt: '2026-07-15T12:00:00.000Z',
          },
        },
      },
    };
    const failure = {
      version: 1,
      requestId: 'request-1',
      type: 'screen.acquire.ack',
      payload: {
        ok: false,
        error: {
          code: 'SCREEN_SHARE_BUSY',
          message: 'Another member is sharing the screen',
          retryable: true,
        },
      },
    };

    expect(ackEnvelopeSchema.safeParse(success).success).toBe(true);
    expect(ackEnvelopeSchema.safeParse(failure).success).toBe(true);

    const assertDiscriminatedPayload = (ack: AckEnvelope) => {
      if (ack.payload.ok) {
        expect(ack.payload.data).toBeDefined();
      } else {
        const code: ErrorCode = ack.payload.error.code;
        expect(code).toBe('SCREEN_SHARE_BUSY');
      }
    };
    assertDiscriminatedPayload(ackEnvelopeSchema.parse(success));
    assertDiscriminatedPayload(ackEnvelopeSchema.parse(failure));

    for (const invalidPayload of [
      { ...success.payload, error: failure.payload.error },
      { ok: true },
      { ...failure.payload, data: {} },
      { ok: false },
    ]) {
      expect(
        ackEnvelopeSchema.safeParse({ ...success, payload: invalidPayload })
          .success,
      ).toBe(false);
    }
  });

  test.each([
    'ROOM_FULL',
    'FORBIDDEN',
    'SCREEN_SHARE_BUSY',
    'LEASE_LOST',
    'INVALID_STATE',
    'MEDIA_NODE_UNAVAILABLE',
    'UNSUPPORTED_PROTOCOL',
    'VALIDATION_ERROR',
  ])('accepts stable error code %s', (code) => {
    expect(
      ackEnvelopeSchema.safeParse({
        version: 1,
        requestId: 'request-1',
        type: 'room.join.ack',
        payload: {
          ok: false,
          error: { code, message: 'Request failed' },
        },
      }).success,
    ).toBe(true);
  });

  test('rejects unknown error codes and arbitrary error details', () => {
    const failure = {
      version: 1,
      requestId: 'request-1',
      type: 'room.join.ack',
      payload: {
        ok: false,
        error: {
          code: 'DATABASE_ERROR',
          message: 'Request failed',
          stack: 'sensitive stack',
          cause: { password: 'secret' },
        },
      },
    };

    expect(ackEnvelopeSchema.safeParse(failure).success).toBe(false);
  });
});

const p2pAck = (requestType: string, data: unknown) => ({
  version: 1,
  requestId: 'request-1',
  type: `${requestType}.ack`,
  payload: { ok: true, data },
});

const p2pBroadcast = (type: string, payload: unknown) => ({
  version: 1,
  eventId: 'event-1',
  type,
  payload,
});

const protocolErrorResponse = (
  requestId: string | null,
  code = 'VALIDATION_ERROR',
) => ({
  version: 1,
  requestId,
  type: 'protocol.error',
  payload: {
    ok: false,
    error: { code, message: 'Request failed' },
  },
});

const validRtcConfiguration = {
  iceServers: [
    { urls: ['stun:rtc.example.com:3478'] },
    {
      urls: ['turn:rtc.example.com:3478?transport=udp'],
      username: '1750000000:opaque-user',
      credential: 'short-lived-credential',
    },
  ],
  iceTransportPolicy: 'all',
};

const validPeer = {
  userId: 'user-2',
  displayName: 'Grace',
  ready: true,
};

const validRoomSessionCommon = {
  roomId: 'room-1',
  connectionEpoch: 2,
  rtcConfiguration: validRtcConfiguration,
  iceCredentialsExpiresAt: '2026-07-16T13:10:00.000Z',
  screen: {
    owner: null,
    leaseId: null,
    leaseExpiresAt: null,
  },
};

const validCreatorWaitingSession = {
  ...validRoomSessionCommon,
  role: 'creator',
  peer: null,
  state: 'waiting',
};

const validCreatorActiveSession = {
  ...validRoomSessionCommon,
  role: 'creator',
  peer: validPeer,
  state: 'connected',
};

const validRoomSession = {
  ...validRoomSessionCommon,
  role: 'joiner',
  peer: validPeer,
  state: 'negotiating',
};

const validSignalBase = {
  roomId: 'room-1',
  negotiationId: 'negotiation-1',
  connectionEpoch: 2,
};

const validOffer = {
  type: 'offer',
  sdp: 'v=0\r\n',
};

const validAnswer = {
  type: 'answer',
  sdp: 'v=0\r\n',
};

const validBrowserCandidate = {
  candidate: 'candidate:1 1 udp 2122260223 host.local 55000 typ host',
  sdpMid: '1',
  sdpMLineIndex: 1,
  usernameFragment: 'abc',
};

describe('HTTP email and password authentication contracts', () => {
  test('normalizes a strict register body without normalizing the password', () => {
    expect(
      authRegisterBodySchema.parse({
        email: '  PERSON@Example.COM ',
        password: '  password with spaces  ',
        displayName: '  Person  ',
      }),
    ).toEqual({
      email: 'person@example.com',
      password: '  password with spaces  ',
      displayName: 'Person',
    });

    expect(
      authRegisterBodySchema.safeParse({
        email: 'person@example.com',
        password: 'short',
        displayName: 'Person',
      }).success,
    ).toBe(false);
    expect(
      authRegisterBodySchema.safeParse({
        email: 'person@example.com',
        password: 'long-enough-password',
        displayName: 'Person',
        admin: true,
      }).success,
    ).toBe(false);
  });

  test('defines strict login, refresh, and logout request bodies', () => {
    expect(
      authLoginBodySchema.parse({
        email: ' Person@Example.com ',
        password: 'long-enough-password',
      }),
    ).toEqual({
      email: 'person@example.com',
      password: 'long-enough-password',
    });

    for (const schema of [authRefreshBodySchema, authLogoutBodySchema]) {
      expect(schema.safeParse({ refreshToken: 'refresh-token' }).success).toBe(
        true,
      );
      expect(
        schema.safeParse({
          refreshToken: 'refresh-token',
          accessToken: 'must-not-be-accepted',
        }).success,
      ).toBe(false);
    }
  });

  test('returns only public user and token fields from auth responses', () => {
    const response = {
      user: {
        userId: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresInSeconds: 900,
    };

    expect(
      parseAuthenticatedAuthResponse({
        ...response,
        status: 'authenticated',
      }),
    ).toEqual(response);

    for (const schema of [
      authRegisterResponseSchema,
      authLoginResponseSchema,
      authRefreshResponseSchema,
    ]) {
      expect(schema.safeParse(response).success).toBe(true);
      expect(
        schema.safeParse({
          ...response,
          passwordHash: '$argon2id$secret',
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...response,
          credentialId: 'credential-row-1',
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ...response,
          user: {
            ...response.user,
            passwordHash: '$argon2id$secret',
            credentialId: 'credential-row-1',
          },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          user: response.user,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresInSeconds: 900,
        }).success,
      ).toBe(false);
    }

    expect(
      authLogoutResponseSchema.safeParse({ loggedOut: true }).success,
    ).toBe(true);
    expect(
      authLogoutResponseSchema.safeParse({
        loggedOut: true,
        refreshToken: 'leaked-token',
      }).success,
    ).toBe(false);
  });

  test('preserves the historical expiry field in legacy refresh acknowledgements', () => {
    const acknowledgement = {
      version: 1,
      requestId: 'request-1',
      type: 'auth.refresh.ack',
      payload: {
        ok: true,
        data: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresInSeconds: 900,
        },
      },
    };

    expect(ackEnvelopeSchema.safeParse(acknowledgement).success).toBe(true);
    expect(
      ackEnvelopeSchema.safeParse({
        ...acknowledgement,
        payload: {
          ok: true,
          data: {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresInSeconds: 900,
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe('signaling ticket response contract', () => {
  const canonicalTicket = 'A'.repeat(43);

  test('accepts a canonical 32-byte unpadded base64url ticket for 30 seconds', () => {
    const response = {
      ticket: canonicalTicket,
      expiresInSeconds: 30,
    };

    expect(signalTicketResponseSchema.parse(response)).toEqual(response);
    expect(
      signalTicketResponseSchema.safeParse({
        ticket: `${'_'.repeat(42)}8`,
        expiresInSeconds: 30,
      }).success,
    ).toBe(true);

    const acceptsSignalTicketResponse = (value: SignalTicketResponse) => value;
    expect(
      acceptsSignalTicketResponse(signalTicketResponseSchema.parse(response)),
    ).toEqual(response);
  });

  test.each([
    ['too short', 'A'.repeat(42)],
    ['too long', 'A'.repeat(44)],
    ['padded', `${'A'.repeat(43)}=`],
    ['standard base64 alphabet', `${'A'.repeat(42)}+`],
    ['whitespace', `${'A'.repeat(42)} `],
    ['noncanonical trailing bits', `${'A'.repeat(42)}B`],
  ])('rejects a %s ticket', (_caseName, ticket) => {
    expect(
      signalTicketResponseSchema.safeParse({
        ticket,
        expiresInSeconds: 30,
      }).success,
    ).toBe(false);
  });

  test.each([0, -1, 1.5, 29, 31, '30'])(
    'rejects a non-contract expiry %#',
    (expiresInSeconds) => {
      expect(
        signalTicketResponseSchema.safeParse({
          ticket: canonicalTicket,
          expiresInSeconds,
        }).success,
      ).toBe(false);
    },
  );

  test('rejects unknown response fields', () => {
    expect(
      signalTicketResponseSchema.safeParse({
        ticket: canonicalTicket,
        expiresInSeconds: 30,
        expiresAt: '2026-07-16T00:00:30.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('two-person room lifecycle contracts', () => {
  test('accepts only six ASCII digits as a public room code', () => {
    expect(roomCodeSchema.safeParse('012345').success).toBe(true);
    expect(roomCodeSchema.safeParse('12345').success).toBe(false);
    expect(roomCodeSchema.safeParse('1234567').success).toBe(false);
    expect(roomCodeSchema.safeParse('１２３４５６').success).toBe(false);
  });

  test('separates branded public users, connections, and negotiations', () => {
    const userId = userIdSchema.parse('user-1');
    const connectionId = connectionIdSchema.parse('connection-1');
    const negotiationId = negotiationIdSchema.parse('negotiation-1');
    const acceptsUserId = (value: UserId) => value;

    expect(acceptsUserId(userId)).toBe('user-1');
    expect(connectionId).toBe('connection-1');
    expect(negotiationId).toBe('negotiation-1');
    // @ts-expect-error Connection IDs cannot be used as user IDs.
    acceptsUserId(connectionId);
    // @ts-expect-error Negotiation IDs cannot be used as user IDs.
    acceptsUserId(negotiationId);
  });

  test('bounds a per-user connection epoch to safe non-negative integers', () => {
    expect(connectionEpochSchema.safeParse(0).success).toBe(true);
    expect(
      connectionEpochSchema.safeParse(Number.MAX_SAFE_INTEGER).success,
    ).toBe(true);
    expect(connectionEpochSchema.safeParse(-1).success).toBe(false);
    expect(connectionEpochSchema.safeParse(1.5).success).toBe(false);
    expect(
      connectionEpochSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success,
    ).toBe(false);
  });

  test('uses bounded room roles and lifecycle states', () => {
    for (const role of ['creator', 'joiner']) {
      expect(roomRoleSchema.safeParse(role).success).toBe(true);
    }
    for (const state of [
      'waiting',
      'negotiating',
      'connected',
      'reconnecting',
      'closed',
    ]) {
      expect(roomStateSchema.safeParse(state).success).toBe(true);
    }
    expect(roomRoleSchema.safeParse('moderator').success).toBe(false);
    expect(roomStateSchema.safeParse('full').success).toBe(false);
  });

  test('accepts every active room request and rejects unknown fields', () => {
    const requests = [
      request('room.create', {}),
      request('room.join', { roomCode: '012345' }),
      request('room.resume', { roomId: 'room-1' }),
      request('room.leave', { roomId: 'room-1' }),
      request('room.end', { roomId: 'room-1' }),
      request('peer.ready', {
        roomId: 'room-1',
        connectionEpoch: 2,
        mediaPlan: P2P_MEDIA_PLAN,
      }),
    ];

    for (const value of requests) {
      expect(
        p2pRequestEnvelopeSchema.safeParse(value),
        value.type,
      ).toMatchObject({ success: true });
    }

    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('room.join', { roomId: 'room-1' }),
      ).success,
    ).toBe(false);
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('room.join', { roomCode: '012345', userId: 'spoofed-user' }),
      ).success,
    ).toBe(false);
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('peer.ready', {
          roomId: 'room-1',
          connectionEpoch: 2,
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('peer.ready', {
          roomId: 'room-1',
          connectionEpoch: 2,
          mediaPlan: 'legacy-two-transceivers',
        }),
      ).success,
    ).toBe(false);
  });

  test('returns sanitized room sessions for create, join, and resume', () => {
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.create', {
          ...validCreatorWaitingSession,
          roomCode: '012345',
        }),
      ).success,
    ).toBe(true);
    expect(
      p2pAckEnvelopeSchema.safeParse(p2pAck('room.join', validRoomSession))
        .success,
    ).toBe(true);
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.resume', {
          ...validRoomSession,
          resume: { status: 'none' },
        }),
      ).success,
    ).toBe(true);

    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.join', {
          ...validRoomSession,
          rtcConfiguration: {
            ...validRtcConfiguration,
            turnSharedSecret: 'must-never-leak',
          },
        }),
      ).success,
    ).toBe(false);
  });

  test('binds create and join acknowledgements to their room roles', () => {
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.create', {
          ...validRoomSession,
          roomCode: '012345',
          role: 'joiner',
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.create', {
          ...validRoomSession,
          roomCode: '012345',
          role: 'creator',
          peer: validPeer,
          state: 'connected',
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.join', {
          ...validRoomSession,
          role: 'creator',
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.join', {
          ...validRoomSession,
          peer: null,
        }),
      ).success,
    ).toBe(false);
  });

  test('accepts only possible successful room session snapshots', () => {
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.create', {
          ...validCreatorWaitingSession,
          roomCode: '012345',
        }),
      ).success,
    ).toBe(true);
    expect(
      p2pAckEnvelopeSchema.safeParse(p2pAck('room.join', validRoomSession))
        .success,
    ).toBe(true);
    for (const snapshot of [
      validCreatorWaitingSession,
      validCreatorActiveSession,
      validRoomSession,
    ]) {
      expect(
        p2pAckEnvelopeSchema.safeParse(
          p2pAck('room.resume', {
            ...snapshot,
            resume: { status: 'none' },
          }),
        ).success,
        `${snapshot.role}:${snapshot.state}`,
      ).toBe(true);
    }

    const impossibleJoinSnapshots = [
      { ...validRoomSession, state: 'waiting' },
      { ...validRoomSession, state: 'closed' },
      { ...validRoomSession, peer: null },
      { ...validRoomSession, role: 'creator' },
    ];
    const impossibleResumeSnapshots = [
      { ...validCreatorWaitingSession, state: 'closed' },
      { ...validCreatorWaitingSession, peer: validPeer },
      { ...validCreatorWaitingSession, state: 'connected' },
      { ...validCreatorActiveSession, peer: null },
      { ...validRoomSession, state: 'waiting' },
      { ...validRoomSession, state: 'closed' },
      { ...validRoomSession, peer: null },
    ];

    for (const snapshot of impossibleJoinSnapshots) {
      expect(
        p2pAckEnvelopeSchema.safeParse(p2pAck('room.join', snapshot)).success,
        `join:${snapshot.role}:${snapshot.state}:${String(snapshot.peer)}`,
      ).toBe(false);
    }
    for (const snapshot of impossibleResumeSnapshots) {
      expect(
        p2pAckEnvelopeSchema.safeParse(p2pAck('room.resume', snapshot)).success,
        `resume:${snapshot.role}:${snapshot.state}:${String(snapshot.peer)}`,
      ).toBe(false);
    }
  });

  test('requires an authoritative all-or-none screen owner snapshot in room sessions', () => {
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.join', {
          ...validRoomSession,
          screen: {
            owner: validPeer,
            leaseId: 'lease-current',
            leaseExpiresAt: '2026-07-16T13:01:00.000Z',
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.join', {
          ...validRoomSession,
          screen: {
            owner: validPeer,
            leaseId: null,
            leaseExpiresAt: '2026-07-16T13:01:00.000Z',
          },
        }),
      ).success,
    ).toBe(false);
  });

  test.each([
    { status: 'none' },
    {
      status: 'completed',
      negotiationId: 'negotiation-completed',
      negotiationGeneration: 7,
    },
    {
      status: 'reset_required',
      negotiationId: 'negotiation-reset',
      resetGeneration: 3,
      reason: 'peer_resumed',
    },
  ] as const)('accepts authoritative room resume disposition %#', (resume) => {
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.resume', { ...validRoomSession, resume }),
      ).success,
    ).toBe(true);
  });

  test.each([
    undefined,
    { status: 'completed', negotiationId: 'negotiation-completed' },
    {
      status: 'reset_required',
      negotiationId: 'negotiation-reset',
      generation: 3,
      reason: 'peer_resumed',
    },
    {
      status: 'reset_required',
      negotiationId: 'negotiation-reset',
      resetGeneration: 0,
      reason: 'peer_resumed',
    },
  ])('rejects incomplete or stale room resume disposition %#', (resume) => {
    expect(
      p2pAckEnvelopeSchema.safeParse(
        p2pAck('room.resume', { ...validRoomSession, resume }),
      ).success,
    ).toBe(false);
  });
});

describe('browser-native WebRTC relay contracts', () => {
  test('accepts a bounded browser ICE candidate and end-of-candidates', () => {
    expect(iceCandidateInitSchema.parse(validBrowserCandidate)).toBeDefined();
    expect(iceCandidateInitSchema.parse(null)).toBeNull();
    expect(
      iceCandidateInitSchema.safeParse({
        ...validBrowserCandidate,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  test('accepts offer, answer, candidate, restart, and refresh requests', () => {
    const requests = [
      request('webrtc.offer', {
        ...validSignalBase,
        description: validOffer,
      }),
      request('webrtc.answer', {
        ...validSignalBase,
        description: validAnswer,
      }),
      request('webrtc.answerApplied', validSignalBase),
      request('webrtc.iceCandidate', {
        ...validSignalBase,
        candidate: validBrowserCandidate,
      }),
      request('webrtc.iceCandidate', {
        ...validSignalBase,
        candidate: null,
      }),
      request('webrtc.iceRestart', {
        ...validSignalBase,
        description: validOffer,
      }),
      request('webrtc.restartRequested', validSignalBase),
      request('webrtc.iceServers.refresh', validSignalBase),
      request('webrtc.recoveryReset', validSignalBase),
    ];

    for (const value of requests) {
      expect(
        p2pRequestEnvelopeSchema.safeParse(value),
        value.type,
      ).toMatchObject({ success: true });
    }
  });

  test('requires current negotiation and connection identifiers', () => {
    for (const field of ['negotiationId', 'connectionEpoch']) {
      const payload = {
        ...validSignalBase,
        description: validOffer,
      };
      delete payload[field as keyof typeof payload];
      expect(
        p2pRequestEnvelopeSchema.safeParse(request('webrtc.offer', payload))
          .success,
        field,
      ).toBe(false);
    }

    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('webrtc.offer', {
          ...validSignalBase,
          connectionEpoch: -1,
          description: validOffer,
        }),
      ).success,
    ).toBe(false);
  });

  test('rejects oversized or structurally invalid SDP and candidates', () => {
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('webrtc.offer', {
          ...validSignalBase,
          description: { type: 'offer', sdp: 'x'.repeat(262_145) },
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('webrtc.offer', {
          ...validSignalBase,
          description: { ...validOffer, internal: true },
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('webrtc.iceCandidate', {
          ...validSignalBase,
          candidate: { candidate: 'x'.repeat(8_193) },
        }),
      ).success,
    ).toBe(false);
  });
});

describe('public STUN and TURN server contracts', () => {
  test.each([
    ['empty STUN authority', { urls: ['stun:'] }],
    [
      'empty TURN authority and blank credentials',
      { urls: ['turn:'], username: ' ', credential: ' ' },
    ],
    ['nested scheme', { urls: ['stun:http://169.254.169.254'] }],
    [
      'embedded userinfo',
      {
        urls: ['turn:user:password@relay.example.com'],
        username: 'user',
        credential: 'credential',
      },
    ],
    ['path', { urls: ['stun:relay.example.com/private'] }],
    ['fragment', { urls: ['stun:relay.example.com#fragment'] }],
    ['control character', { urls: ['stun:relay.example.com\u0000'] }],
    ['TLS STUN scheme', { urls: ['stuns:relay.example.com:5349'] }],
    ['STUN query', { urls: ['stun:relay.example.com?transport=udp'] }],
    [
      'TURN TLS over unsupported UDP transport',
      {
        urls: ['turns:relay.example.com:5349?transport=udp'],
        username: 'user',
        credential: 'credential',
      },
    ],
    [
      'unsupported TURN query',
      {
        urls: ['turn:relay.example.com?region=cn'],
        username: 'user',
        credential: 'credential',
      },
    ],
    [
      'duplicate TURN query',
      {
        urls: ['turn:relay.example.com?transport=udp&transport=tcp'],
        username: 'user',
        credential: 'credential',
      },
    ],
    [
      'extra TURN query',
      {
        urls: ['turn:relay.example.com?transport=udp&region=cn'],
        username: 'user',
        credential: 'credential',
      },
    ],
    ['zero port', { urls: ['stun:relay.example.com:0'] }],
    ['out-of-range port', { urls: ['stun:relay.example.com:65536'] }],
    ['invalid hostname', { urls: ['stun:-relay.example.com'] }],
  ])('rejects %s', (_caseName, value) => {
    expect(publicIceServerSchema.safeParse(value).success).toBe(false);
  });

  test.each([
    'stun:relay.example.com',
    'stun:relay.example.com:3478',
    'stun:203.0.113.10',
    'stun:203.0.113.10:3478',
    'stun:[2001:db8::10]',
    'stun:[2001:db8::10]:3478',
    'turn:relay.example.com',
    'turn:relay.example.com:3478?transport=udp',
    'turn:203.0.113.10:3478?transport=tcp',
    'turn:[2001:db8::10]:3478?transport=udp',
    'turns:relay.example.com',
    'turns:relay.example.com:5349?transport=tcp',
    'turns:[2001:db8::10]:5349?transport=tcp',
  ])('accepts valid ICE server URI %s', (url) => {
    expect(iceServerUrlSchema.safeParse(url).success).toBe(true);

    const value =
      url.startsWith('turn:') || url.startsWith('turns:')
        ? { urls: [url], username: 'user', credential: 'credential' }
        : { urls: [url] };
    expect(publicIceServerSchema.safeParse(value).success).toBe(true);
  });

  test.each([
    { username: '   ', credential: 'credential' },
    { username: 'user', credential: '\t\r\n' },
    { username: 'user\u0000', credential: 'credential' },
    { username: 'user', credential: 'credential\u007f' },
  ])('rejects unsafe separate TURN credentials %#', (credentials) => {
    expect(
      publicIceServerSchema.safeParse({
        urls: ['turn:relay.example.com'],
        ...credentials,
      }).success,
    ).toBe(false);
  });

  test('preserves bounded TURN credential bytes without trimming', () => {
    const value = {
      urls: ['turn:relay.example.com?transport=tcp'],
      username: '  expiring-user  ',
      credential: '  generated-credential  ',
    };

    expect(publicIceServerSchema.parse(value)).toEqual(value);
  });

  test('requires separate credentials only when an entry contains TURN', () => {
    expect(
      publicIceServerSchema.safeParse({
        urls: ['turns:relay.example.com:5349?transport=tcp'],
      }).success,
    ).toBe(false);
    expect(
      publicIceServerSchema.safeParse({
        urls: ['turn:relay.example.com'],
      }).success,
    ).toBe(false);
    expect(
      publicIceServerSchema.safeParse({
        urls: ['stun:relay.example.com'],
        username: 'user',
        credential: 'credential',
      }).success,
    ).toBe(false);
  });
});

describe('active P2P envelope unions', () => {
  test('exports inferred types for active public schemas', () => {
    expect(preservePublicP2pSchemaTypes(undefined)).toBeUndefined();
  });

  test('rejects SFU and legacy bitrate messages from the P2P request union', () => {
    const legacyTransport = transportCreateRequestSchema.parse(
      request('transport.create', {
        roomId: 'room-1',
        direction: 'send',
      }),
    );

    expect(p2pRequestEnvelopeSchema.safeParse(legacyTransport).success).toBe(
      false,
    );
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('producer.close', {
          roomId: 'room-1',
          producerId: 'producer-1',
        }),
      ).success,
    ).toBe(false);
    expect(
      p2pRequestEnvelopeSchema.safeParse(
        request('screen.setTargetBitrate', {
          roomId: 'room-1',
          leaseId: 'lease-1',
          bitrate: 6_000_000,
        }),
      ).success,
    ).toBe(false);

    const acceptsP2pRequest = (value: P2pRequestEnvelope) => value;
    // @ts-expect-error SFU transport requests are not active P2P requests.
    acceptsP2pRequest(legacyTransport);
  });

  test('accepts all active screen requests including screen.bitrate', () => {
    const requests = [
      request('screen.acquire', { roomId: 'room-1' }),
      request('screen.renew', { roomId: 'room-1', leaseId: 'lease-1' }),
      request('screen.release', { roomId: 'room-1', leaseId: 'lease-1' }),
      request('screen.bitrate', {
        roomId: 'room-1',
        leaseId: 'lease-1',
        bitrate: 6_000_000,
      }),
    ];

    for (const value of requests) {
      expect(
        p2pRequestEnvelopeSchema.safeParse(value).success,
        value.type,
      ).toBe(true);
    }
    expect(screenBitrateRequestSchema.safeParse(requests.at(-1)).success).toBe(
      true,
    );
  });

  test('accepts every active acknowledgement and active stale error', () => {
    const lease = {
      roomId: 'room-1',
      leaseId: 'lease-1',
      holderId: 'user-1',
      expiresAt: '2026-07-16T13:00:00.000Z',
    };
    const acknowledgements = [
      p2pAck('room.create', {
        ...validRoomSession,
        roomCode: '012345',
        role: 'creator',
        peer: null,
        state: 'waiting',
      }),
      p2pAck('room.join', validRoomSession),
      p2pAck('room.resume', {
        ...validRoomSession,
        resume: { status: 'none' },
      }),
      p2pAck('room.leave', {}),
      p2pAck('room.end', {}),
      p2pAck('peer.ready', {}),
      p2pAck('webrtc.offer', {}),
      p2pAck('webrtc.answer', {}),
      p2pAck('webrtc.answerApplied', {}),
      p2pAck('webrtc.iceCandidate', {}),
      p2pAck('webrtc.iceRestart', {}),
      p2pAck('webrtc.restartRequested', {}),
      p2pAck('webrtc.iceServers.refresh', {
        rtcConfiguration: validRtcConfiguration,
        iceCredentialsExpiresAt: '2026-07-16T13:10:00.000Z',
      }),
      p2pAck('webrtc.recoveryReset', {
        negotiationId: 'negotiation-reset',
        resetGeneration: 2,
        reason: 'signaling_reset',
      }),
      p2pAck('screen.acquire', { lease }),
      p2pAck('screen.renew', { lease }),
      p2pAck('screen.release', {}),
      p2pAck('screen.bitrate', { bitrate: 6_000_000 }),
    ];

    for (const value of acknowledgements) {
      expect(p2pAckEnvelopeSchema.safeParse(value).success, value.type).toBe(
        true,
      );
    }

    for (const code of [
      'INVALID_CREDENTIALS',
      'AUTH_REQUIRED',
      'ROOM_CODE_INVALID',
      'ROOM_CODE_EXPIRED',
      'ROOM_CLOSED',
      'STALE_CONNECTION',
      'STALE_NEGOTIATION',
      'RATE_LIMITED',
      'SIGNALING_UNAVAILABLE',
    ]) {
      expect(
        p2pAckEnvelopeSchema.safeParse({
          version: 1,
          requestId: 'request-1',
          type: 'room.join.ack',
          payload: {
            ok: false,
            error: { code, message: 'Request failed' },
          },
        }).success,
        code,
      ).toBe(true);
    }

    expect(
      p2pAckEnvelopeSchema.safeParse({
        version: 1,
        requestId: 'request-1',
        type: 'room.join.ack',
        payload: {
          ok: false,
          error: {
            code: 'MEDIA_NODE_UNAVAILABLE',
            message: 'Legacy SFU failure',
          },
        },
      }).success,
    ).toBe(false);
  });

  test('accepts protocol errors with a valid or unavailable request ID', () => {
    const withRequestId = protocolErrorResponse(
      'request-1',
      'UNSUPPORTED_PROTOCOL',
    );
    const withoutRequestId = protocolErrorResponse(null);

    expect(protocolErrorResponseSchema.parse(withRequestId)).toEqual(
      withRequestId,
    );
    expect(protocolErrorResponseSchema.parse(withoutRequestId)).toEqual(
      withoutRequestId,
    );

    const acceptsProtocolErrorResponse = (value: ProtocolErrorResponse) =>
      value;
    expect(
      acceptsProtocolErrorResponse(
        protocolErrorResponseSchema.parse(withoutRequestId),
      ),
    ).toEqual(withoutRequestId);
  });

  test('requires a legal request ID when a protocol error identifies a request', () => {
    expect(
      protocolErrorResponseSchema.safeParse(protocolErrorResponse('')).success,
    ).toBe(false);
    expect(
      protocolErrorResponseSchema.safeParse(
        protocolErrorResponse('x'.repeat(129)),
      ).success,
    ).toBe(false);
  });

  test('keeps protocol error envelopes, payloads, and P2P error codes strict', () => {
    const valid = protocolErrorResponse(null);

    expect(
      protocolErrorResponseSchema.safeParse({ ...valid, debug: true }).success,
    ).toBe(false);
    expect(
      protocolErrorResponseSchema.safeParse({
        ...valid,
        payload: { ...valid.payload, data: {} },
      }).success,
    ).toBe(false);
    expect(
      protocolErrorResponseSchema.safeParse({
        ...valid,
        payload: {
          ...valid.payload,
          error: { ...valid.payload.error, stack: 'sensitive stack' },
        },
      }).success,
    ).toBe(false);
    expect(
      protocolErrorResponseSchema.safeParse(
        protocolErrorResponse(null, 'MEDIA_NODE_UNAVAILABLE'),
      ).success,
    ).toBe(false);
    expect(
      protocolErrorResponseSchema.safeParse(
        protocolErrorResponse(null, 'DATABASE_ERROR'),
      ).success,
    ).toBe(false);
  });

  test('accepts acknowledgements, broadcasts, and protocol errors as outbound responses', () => {
    const acknowledgement = p2pAck('room.leave', {});
    const broadcast = p2pBroadcast('room.closed', {
      roomId: 'room-1',
      reason: 'ended',
    });
    const error = protocolErrorResponse(null);

    for (const value of [acknowledgement, broadcast, error]) {
      expect(
        p2pOutboundResponseSchema.safeParse(value).success,
        value.type,
      ).toBe(true);
    }
    expect(
      p2pOutboundResponseSchema.safeParse(request('room.create', {})).success,
    ).toBe(false);

    const acceptsP2pOutboundResponse = (value: P2pOutboundResponse) => value;
    expect(
      acceptsP2pOutboundResponse(p2pOutboundResponseSchema.parse(error)),
    ).toEqual(error);
  });

  test('accepts all peer, room, WebRTC, and screen broadcasts', () => {
    const broadcasts = [
      p2pBroadcast('peer.joined', { roomId: 'room-1', peer: validPeer }),
      p2pBroadcast('peer.left', {
        roomId: 'room-1',
        userId: 'user-2',
        reason: 'disconnected',
      }),
      p2pBroadcast('peer.ready', { roomId: 'room-1', peer: validPeer }),
      p2pBroadcast('room.closed', { roomId: 'room-1', reason: 'ended' }),
      p2pBroadcast('webrtc.offer', {
        ...validSignalBase,
        description: validOffer,
      }),
      p2pBroadcast('webrtc.answer', {
        ...validSignalBase,
        description: validAnswer,
      }),
      p2pBroadcast('webrtc.iceCandidate', {
        ...validSignalBase,
        candidate: validBrowserCandidate,
      }),
      p2pBroadcast('webrtc.iceRestart', {
        ...validSignalBase,
        description: validOffer,
      }),
      p2pBroadcast('webrtc.restartRequested', validSignalBase),
      p2pBroadcast('webrtc.negotiationReset', {
        roomId: 'room-1',
        negotiationId: 'negotiation-2',
        resetGeneration: 1,
        reason: 'peer_resumed',
      }),
      p2pBroadcast('screen.ownerChanged', {
        roomId: 'room-1',
        owner: validPeer,
        leaseId: 'lease-1',
        leaseExpiresAt: '2026-07-16T13:00:00.000Z',
      }),
      p2pBroadcast('screen.ownerChanged', {
        roomId: 'room-1',
        owner: null,
        leaseId: null,
        leaseExpiresAt: null,
      }),
      p2pBroadcast('screen.bitrate', {
        roomId: 'room-1',
        leaseId: 'lease-1',
        bitrate: 6_000_000,
      }),
    ];

    for (const value of broadcasts) {
      expect(
        p2pBroadcastEnvelopeSchema.safeParse(value).success,
        value.type,
      ).toBe(true);
    }

    expect(peerReadyBroadcastSchema.safeParse(broadcasts[2]).success).toBe(
      true,
    );
    expect(
      screenOwnerChangedBroadcastSchema.safeParse(broadcasts[10]).success,
    ).toBe(true);
    expect(
      p2pBroadcastEnvelopeSchema.safeParse({
        ...broadcasts[4],
        rawSocket: true,
      }).success,
    ).toBe(false);
  });
});
