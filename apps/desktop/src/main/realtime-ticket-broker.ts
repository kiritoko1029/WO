import { opaqueTokenSchema, signalTicketResponseSchema } from '@wo/protocol';

import type { SignalTicketResponse } from '@wo/protocol';
import type { MainHttpClient } from './http-client.js';

export interface RealtimeConnectionGrant extends SignalTicketResponse {
  readonly endpoint: string;
}

export interface RealtimeTicketBroker {
  issueTicket(accessToken: string): Promise<RealtimeConnectionGrant>;
}

export interface RealtimeTicketBrokerOptions {
  readonly http: MainHttpClient;
  readonly realtimeOrigin: string;
}

function realtimeEndpoint(origin: string): string {
  const url = new URL(origin);
  if (
    url.protocol !== 'wss:' ||
    url.origin !== origin ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Realtime origin must be a canonical WSS origin');
  }
  return `${url.origin}/v1/realtime`;
}

export function createRealtimeTicketBroker(
  options: RealtimeTicketBrokerOptions,
): Readonly<RealtimeTicketBroker> {
  const endpoint = realtimeEndpoint(options.realtimeOrigin);
  const broker: RealtimeTicketBroker = {
    issueTicket: async (accessToken) => {
      const response = await options.http.post({
        path: '/v1/realtime/ticket',
        body: undefined,
        bearerToken: opaqueTokenSchema.parse(accessToken),
        responseSchema: signalTicketResponseSchema,
      });
      return Object.freeze({ endpoint, ...response });
    },
  };
  return Object.freeze(broker);
}
