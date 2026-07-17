import { serverJoinIntentSchema, type ServerJoinIntent } from '@wo/protocol';

interface WebJoinLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export function parseWebJoinIntent(
  location: WebJoinLocation,
): ServerJoinIntent | null {
  if (location.search !== '' || location.hash !== '') return null;
  const match = /^\/join\/(\d{6})$/u.exec(location.pathname);
  if (match === null) return null;
  const parsed = serverJoinIntentSchema.safeParse({
    version: 1,
    mode: 'server',
    serverOrigin: location.origin,
    roomCode: match[1],
  });
  return parsed.success ? parsed.data : null;
}
