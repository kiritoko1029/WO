import type {
  AcquireScreenLeaseInput,
  CurrentConnectionInput,
  ReleaseScreenLeaseInput,
  RenewScreenLeaseInput,
  RoomRegistry,
  SetScreenBitrateInput,
} from '../rooms/room-types.ts';

export interface ScreenLeaseRegistry {
  acquire(
    input: AcquireScreenLeaseInput,
  ): ReturnType<RoomRegistry['acquireScreenLease']>;
  renew(
    input: RenewScreenLeaseInput,
  ): ReturnType<RoomRegistry['renewScreenLease']>;
  release(
    input: ReleaseScreenLeaseInput,
  ): ReturnType<RoomRegistry['releaseScreenLease']>;
  setBitrate(
    input: SetScreenBitrateInput,
  ): ReturnType<RoomRegistry['setScreenBitrate']>;
  current(
    input: CurrentConnectionInput,
  ): ReturnType<RoomRegistry['getScreenLease']>;
}

export function createScreenLeaseRegistry(dependencies: {
  readonly roomRegistry: RoomRegistry;
}): ScreenLeaseRegistry {
  return Object.freeze({
    acquire: (input: AcquireScreenLeaseInput) =>
      dependencies.roomRegistry.acquireScreenLease(input),
    renew: (input: RenewScreenLeaseInput) =>
      dependencies.roomRegistry.renewScreenLease(input),
    release: (input: ReleaseScreenLeaseInput) =>
      dependencies.roomRegistry.releaseScreenLease(input),
    setBitrate: (input: SetScreenBitrateInput) =>
      dependencies.roomRegistry.setScreenBitrate(input),
    current: (input: CurrentConnectionInput) =>
      dependencies.roomRegistry.getScreenLease(input),
  });
}
