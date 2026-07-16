import { describe, expect, it, vi } from 'vitest';

import { createRealtimeTicketBroker } from '../src/main/realtime-ticket-broker.js';
import type { MainHttpClient } from '../src/main/http-client.js';

const ticket = 'A'.repeat(43);

describe('realtime ticket broker', () => {
  it('uses the renderer access token only as a bearer header and sends no body', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ ticket, expiresInSeconds: 30 }),
    } satisfies MainHttpClient;
    const broker = createRealtimeTicketBroker({ http });

    await expect(broker.issueTicket('access-token')).resolves.toEqual({
      ticket,
      expiresInSeconds: 30,
    });
    expect(http.post).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/realtime/ticket',
        bearerToken: 'access-token',
        body: undefined,
      }),
    );
  });

  it('rejects an invalid access token before calling the server', async () => {
    const http = { post: vi.fn() } satisfies MainHttpClient;
    const broker = createRealtimeTicketBroker({ http });

    await expect(broker.issueTicket('')).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });
});
