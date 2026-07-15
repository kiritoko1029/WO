import { describe, expect, test } from 'vitest';

import {
  PROTOCOL_VERSION,
  ackEnvelopeSchema,
  authRefreshRequestSchema,
  broadcastEnvelopeSchema,
  consumerIdSchema,
  consumerCreateAckDataSchema,
  dtlsFingerprintSchema,
  dtlsParametersSchema,
  eventIdSchema,
  iceCandidateSchema,
  inboundEnvelopeSchema,
  leaseIdSchema,
  memberIdSchema,
  producerCreatePayloadSchema,
  producerIdSchema,
  requestIdSchema,
  roomIdSchema,
  rtpCapabilitiesSchema,
  rtpParametersSchema,
  screenLeaseSchema,
  screenSetTargetBitrateRequestSchema,
  transportIdSchema,
  type AckEnvelope,
  type ConsumerId,
  type ErrorCode,
  type EventId,
  type LeaseId,
  type MemberId,
  type ProducerId,
  type RequestId,
  type RoomId,
  type TransportId,
} from '../src/index.js';

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
  test.each([1_000_000, 10_000_000])(
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

  test.each([999_999, 10_000_001, 1_500_000.5])(
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
