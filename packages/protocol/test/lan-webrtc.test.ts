import { describe, expect, test } from 'vitest';

import {
  centralRtcConfigurationSchema,
  lanIceConfigurationDataSchema,
  lanRtcConfigurationSchema,
  roomCreateAckSchema,
  rtcConfigurationSchema,
  webrtcIceServersRefreshAckSchema,
} from '../src/index.js';

const lanIce = {
  rtcConfiguration: {
    mode: 'lan',
    iceServers: [],
    iceTransportPolicy: 'all',
  },
  iceCredentialsExpiresAt: '2026-07-17T12:00:00.000Z',
} as const;

describe('LAN ICE configuration', () => {
  test('allows empty ICE servers only for the explicit LAN variant', () => {
    expect(lanRtcConfigurationSchema.parse(lanIce.rtcConfiguration)).toEqual(
      lanIce.rtcConfiguration,
    );
    expect(rtcConfigurationSchema.parse(lanIce.rtcConfiguration)).toEqual(
      lanIce.rtcConfiguration,
    );
    expect(lanIceConfigurationDataSchema.parse(lanIce)).toEqual(lanIce);

    expect(
      centralRtcConfigurationSchema.safeParse({
        iceServers: [],
        iceTransportPolicy: 'all',
      }).success,
    ).toBe(false);
    expect(
      lanRtcConfigurationSchema.safeParse({
        ...lanIce.rtcConfiguration,
        iceServers: [{ urls: ['stun:192.168.1.10:3478'] }],
      }).success,
    ).toBe(false);
    expect(
      lanRtcConfigurationSchema.safeParse({
        ...lanIce.rtcConfiguration,
        iceTransportPolicy: 'relay',
      }).success,
    ).toBe(false);
  });

  test('accepts LAN ICE in room and refresh acknowledgements', () => {
    const session = {
      roomId: 'room-1',
      connectionEpoch: 1,
      role: 'creator',
      state: 'waiting',
      peer: null,
      screen: {
        owner: null,
        leaseId: null,
        leaseExpiresAt: null,
      },
      roomCode: '012345',
      ...lanIce,
    };
    expect(
      roomCreateAckSchema.safeParse({
        version: 1,
        requestId: 'create-1',
        type: 'room.create.ack',
        payload: { ok: true, data: session },
      }).success,
    ).toBe(true);
    expect(
      webrtcIceServersRefreshAckSchema.safeParse({
        version: 1,
        requestId: 'refresh-1',
        type: 'webrtc.iceServers.refresh.ack',
        payload: { ok: true, data: lanIce },
      }).success,
    ).toBe(true);
  });
});
