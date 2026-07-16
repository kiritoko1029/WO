import { randomInt as nodeRandomInt } from 'node:crypto';

export const ROOM_CODE_SPACE = 1_000_000;

export interface RoomCodeDependencies {
  readonly randomInt?: (maxExclusive: number) => number;
}

export function generateRoomCode(
  dependencies: RoomCodeDependencies = {},
): string {
  const value = (dependencies.randomInt ?? nodeRandomInt)(ROOM_CODE_SPACE);
  if (!Number.isInteger(value) || value < 0 || value >= ROOM_CODE_SPACE) {
    throw new RangeError(
      `Room-code random source must return an integer from 0 to ${ROOM_CODE_SPACE - 1}`,
    );
  }
  return String(value).padStart(6, '0');
}
