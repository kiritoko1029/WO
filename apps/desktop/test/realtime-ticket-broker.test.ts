import { describe, expect, it, vi } from 'vitest';

import { createRealtimeTicketBroker } from '../src/main/realtime-ticket-broker.js';
import type { MainHttpClient } from '../src/main/http-client.js';

const ticket = 'A'.repeat(43);

describe('realtime ticket broker', () => {
  it('uses the renderer access token only as a bearer header and sends no body', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ ticket, expiresInSeconds: 30 }),
    } satisfies MainHttpClient;
    const broker = createRealtimeTicketBroker({
      http,
      realtimeOrigin: 'wss://rtc.example.cn',
    });

    await expect(broker.issueTicket('access-token')).resolves.toEqual({
      endpoint: 'wss://rtc.example.cn/v1/realtime',
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
    const broker = createRealtimeTicketBroker({
      http,
      realtimeOrigin: 'wss://rtc.example.cn',
    });

    await expect(broker.issueTicket('')).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    'https://rtc.example.cn',
    'wss://rtc.example.cn/path',
    'wss://user@rtc.example.cn',
    'wss://rtc.example.cn?token=leak',
  ])('rejects a non-canonical realtime origin %s', (realtimeOrigin) => {
    const http = { post: vi.fn() } satisfies MainHttpClient;

    expect(() => createRealtimeTicketBroker({ http, realtimeOrigin })).toThrow(
      'canonical WSS origin',
    );
  });
});
