import { describe, expect, test } from 'vitest';

import { createJoinProtocolUrl, joinIntentSchema } from '../src/index.js';

describe('join intents', () => {
  test('accepts a strict central-service intent', () => {
    expect(
      joinIntentSchema.parse({
        version: 1,
        mode: 'server',
        serverOrigin: 'https://wo.example.com',
        roomCode: '123456',
      }),
    ).toEqual({
      version: 1,
      mode: 'server',
      serverOrigin: 'https://wo.example.com',
      roomCode: '123456',
    });
  });

  test('serializes the explicit custom-protocol version', () => {
    expect(
      createJoinProtocolUrl({
        version: 1,
        mode: 'server',
        serverOrigin: 'https://wo.example.com',
        roomCode: '123456',
      }),
    ).toBe(
      'wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
    );
  });

  test.each([
    'http://wo.example.com',
    'https://wo.example.com/',
    'https://user@wo.example.com',
    'https://wo.example.com/path',
  ])('rejects a non-canonical central origin: %s', (serverOrigin) => {
    expect(
      joinIntentSchema.safeParse({
        version: 1,
        mode: 'server',
        serverOrigin,
        roomCode: '123456',
      }).success,
    ).toBe(false);
  });

  test('accepts a private-LAN realtime intent', () => {
    expect(
      joinIntentSchema.parse({
        version: 1,
        mode: 'lan',
        endpoint: 'ws://192.168.1.20:43123/v1/realtime',
        roomCode: '654321',
        inviteKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).toEqual({
      version: 1,
      mode: 'lan',
      endpoint: 'ws://192.168.1.20:43123/v1/realtime',
      roomCode: '654321',
      inviteKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
  });

  test.each([
    'wss://192.168.1.20:43123/v1/realtime',
    'ws://8.8.8.8:43123/v1/realtime',
    'ws://127.0.0.1:43123/v1/realtime',
    'ws://169.254.1.20:43123/v1/realtime',
    'ws://192.168.1.20/v1/realtime',
    'ws://192.168.1.20:43123/other',
  ])('rejects a non-LAN endpoint: %s', (endpoint) => {
    expect(
      joinIntentSchema.safeParse({
        version: 1,
        mode: 'lan',
        endpoint,
        roomCode: '654321',
        inviteKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }).success,
    ).toBe(false);
  });

  test('rejects unknown fields, invalid room codes, and short keys', () => {
    expect(
      joinIntentSchema.safeParse({
        version: 1,
        mode: 'lan',
        endpoint: 'ws://10.0.0.8:43123/v1/realtime',
        roomCode: '12345',
        inviteKey: 'too-short',
        extra: true,
      }).success,
    ).toBe(false);
  });
});
