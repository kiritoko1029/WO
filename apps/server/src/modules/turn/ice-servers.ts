import {
  iceConfigurationDataSchema,
  iceServerUrlSchema,
  type IceConfigurationData,
} from '@wo/protocol';

import type { TurnCredentials } from './credentials.ts';

export interface CreateIceConfigurationInput {
  readonly urls: readonly string[];
  readonly turnCredentials: TurnCredentials;
  readonly iceTransportPolicy?: 'all' | 'relay';
}

const parseCredentialExpiration = (credentials: TurnCredentials): string => {
  if (
    !Number.isSafeInteger(credentials.expiresAtSeconds) ||
    credentials.expiresAtSeconds < 0
  ) {
    throw new RangeError('TURN credential expiration is invalid');
  }
  const expectedPrefix = `${credentials.expiresAtSeconds}:`;
  if (!credentials.username.startsWith(expectedPrefix)) {
    throw new TypeError('TURN username expiration is inconsistent');
  }

  const expiration = new Date(credentials.expiresAtSeconds * 1_000);
  if (!Number.isFinite(expiration.getTime())) {
    throw new RangeError('TURN credential expiration is outside date range');
  }
  return expiration.toISOString();
};

const deepFreezeIceConfiguration = (
  configuration: IceConfigurationData,
): IceConfigurationData => {
  for (const server of configuration.rtcConfiguration.iceServers) {
    Object.freeze(server.urls);
    Object.freeze(server);
  }
  Object.freeze(configuration.rtcConfiguration.iceServers);
  Object.freeze(configuration.rtcConfiguration);
  return Object.freeze(configuration);
};

export function createIceConfiguration(
  input: CreateIceConfigurationInput,
): IceConfigurationData {
  if (!Array.isArray(input.urls) || input.urls.length === 0) {
    throw new TypeError('At least one configured ICE server URL is required');
  }

  const stunUrls: string[] = [];
  const turnUrls: string[] = [];
  for (const configuredUrl of input.urls) {
    const url = iceServerUrlSchema.parse(configuredUrl);
    if (url.startsWith('stun:')) {
      stunUrls.push(url);
    } else {
      turnUrls.push(url);
    }
  }
  if (turnUrls.length === 0) {
    throw new TypeError('At least one configured TURN server URL is required');
  }

  const iceServers = [
    ...(stunUrls.length === 0 ? [] : [{ urls: [...stunUrls] }]),
    {
      urls: [...turnUrls],
      username: input.turnCredentials.username,
      credential: input.turnCredentials.credential,
    },
  ];
  const parsed = iceConfigurationDataSchema.parse({
    rtcConfiguration: {
      iceServers,
      iceTransportPolicy: input.iceTransportPolicy ?? 'all',
    },
    iceCredentialsExpiresAt: parseCredentialExpiration(input.turnCredentials),
  });
  return deepFreezeIceConfiguration(parsed);
}
