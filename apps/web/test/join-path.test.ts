import { describe, expect, test } from 'vitest';

import { parseWebJoinIntent } from '../src/join-path.js';

const location = (pathname: string, search = '', hash = '') => ({
  origin: 'https://wo.example.test',
  pathname,
  search,
  hash,
});

describe('Web join path', () => {
  test('creates a same-origin server join intent for an exact room path', () => {
    expect(parseWebJoinIntent(location('/join/123456'))).toEqual({
      version: 1,
      mode: 'server',
      serverOrigin: 'https://wo.example.test',
      roomCode: '123456',
    });
  });

  test.each([
    ['/join/12345', '', ''],
    ['/join/123456/', '', ''],
    ['/join/123456', '?room=654321', ''],
    ['/join/123456', '', '#654321'],
  ])('rejects a non-canonical join location', (pathname, search, hash) => {
    expect(parseWebJoinIntent(location(pathname, search, hash))).toBeNull();
  });

  test('rejects a non-HTTPS origin', () => {
    expect(
      parseWebJoinIntent({
        ...location('/join/123456'),
        origin: 'http://wo.example.test',
      }),
    ).toBeNull();
  });
});
