import { describe, expect, test } from 'vitest';

import { generateRoomCode } from '../src/modules/rooms/room-code.ts';

describe('temporary room codes', () => {
  test('pads a cryptographically supplied number to six digits', () => {
    expect(generateRoomCode({ randomInt: () => 42 })).toBe('000042');
  });

  test.each([-1, 1_000_000, 1.5, Number.NaN])(
    'rejects an invalid random source result %s',
    (value) => {
      expect(() => generateRoomCode({ randomInt: () => value })).toThrow(
        RangeError,
      );
    },
  );
});
