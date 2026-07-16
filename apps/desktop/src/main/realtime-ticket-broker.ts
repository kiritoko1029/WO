import { opaqueTokenSchema, signalTicketResponseSchema } from '@wo/protocol';

import type { SignalTicketResponse } from '@wo/protocol';
import type { MainHttpClient } from './http-client.js';

export interface RealtimeTicketBroker {
  issueTicket(accessToken: string): Promise<SignalTicketResponse>;
}

export interface RealtimeTicketBrokerOptions {
  readonly http: MainHttpClient;
}

export function createRealtimeTicketBroker(
  options: RealtimeTicketBrokerOptions,
): Readonly<RealtimeTicketBroker> {
  const broker: RealtimeTicketBroker = {
    issueTicket: async (accessToken) =>
      options.http.post({
        path: '/v1/realtime/ticket',
        body: undefined,
        bearerToken: opaqueTokenSchema.parse(accessToken),
        responseSchema: signalTicketResponseSchema,
      }),
  };
  return Object.freeze(broker);
}
