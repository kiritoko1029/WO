import { describe, expect, test } from 'vitest';

import {
  createJoinProtocolUrl,
  createPendingJoinIntentStore,
  createServerShareUrl,
  findJoinIntent,
  parseJoinIntent,
  withoutJoinIntentArguments,
} from '../src/main/join-intent.js';

const inviteKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('desktop join intent URLs', () => {
  test('parses the canonical HTTPS room link', () => {
    expect(parseJoinIntent('https://wo.example.com/join/123456')).toEqual({
      version: 1,
      mode: 'server',
      serverOrigin: 'https://wo.example.com',
      roomCode: '123456',
    });
  });

  test('round-trips a central custom-protocol link', () => {
    const intent = {
      version: 1 as const,
      mode: 'server' as const,
      serverOrigin: 'https://wo.example.com',
      roomCode: '123456',
    };
    expect(parseJoinIntent(createJoinProtocolUrl(intent))).toEqual(intent);
    expect(createServerShareUrl(intent)).toBe(
      'https://wo.example.com/join/123456',
    );
  });

  test('round-trips a LAN custom-protocol link without losing the key', () => {
    const intent = {
      version: 1 as const,
      mode: 'lan' as const,
      endpoint: 'ws://192.168.10.8:43123/v1/realtime',
      roomCode: '654321',
      inviteKey,
    };
    expect(parseJoinIntent(createJoinProtocolUrl(intent))).toEqual(intent);
  });

  test('finds the first valid URL in process arguments', () => {
    expect(
      findJoinIntent([
        '/Applications/WO.app/Contents/MacOS/WO',
        '--ignored',
        'wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
      ]),
    ).toMatchObject({ mode: 'server', roomCode: '123456' });
  });

  test('keeps only the newest intent and consumes it once', () => {
    const store = createPendingJoinIntentStore();
    store.push({
      version: 1,
      mode: 'server',
      serverOrigin: 'https://one.example',
      roomCode: '111111',
    });
    store.push({
      version: 1,
      mode: 'server',
      serverOrigin: 'https://two.example',
      roomCode: '222222',
    });

    expect(store.consume()).toMatchObject({
      serverOrigin: 'https://two.example',
      roomCode: '222222',
    });
    expect(store.consume()).toBeNull();
  });

  test('removes consumed join URLs before a relaunch', () => {
    expect(
      withoutJoinIntentArguments([
        'app-entry',
        '--flag',
        'wo://join?v=1&mode=server&origin=https%3A%2F%2Fold.example&room=111111',
      ]),
    ).toEqual(['app-entry', '--flag']);
  });

  test.each([
    'https://wo.example.com/join/123456/',
    'https://wo.example.com/join/123456?next=x',
    'http://wo.example.com/join/123456',
    'wo://other?v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
    'wo://join?mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
    'wo://join?v=2&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
    'wo://join?v=1&v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
    'wo://join?v=1&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456&extra=x',
    'wo://join?v=1&mode=server&mode=server&origin=https%3A%2F%2Fwo.example.com&room=123456',
    `wo://join?v=1&mode=lan&endpoint=${encodeURIComponent(
      'ws://8.8.8.8:43123/v1/realtime',
    )}&room=654321&key=${inviteKey}`,
  ])('rejects an unsafe or ambiguous join URL: %s', (value) => {
    expect(parseJoinIntent(value)).toBeNull();
  });
});
