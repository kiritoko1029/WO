import { describe, expect, it, vi } from 'vitest';

import { createLanSessionController } from '../src/main/lan-session.js';

const endpoint = 'ws://192.168.1.24:43120/v1/realtime';
const inviteKey = 'A'.repeat(43);
const ticket = 'E'.repeat(43);

describe('desktop LAN session controller', () => {
  it('starts and stops a host service while issuing host tickets', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const issueHostTicket = vi.fn(() => ({
      ticket,
      expiresInSeconds: 30,
    }));
    const startService = vi.fn().mockResolvedValue({
      hostClientId: '00000000-0000-4000-8000-000000000011',
      hostDisplayName: '房主',
      invite: {
        version: 1,
        endpoint,
        sessionEndpoint: 'http://192.168.1.24:43120/v1/lite/session',
        roomCode: '482731',
        inviteKey,
      },
      issueHostTicket,
      close,
    });
    const sessions = createLanSessionController({
      startService,
      now: () => 1_000,
    });

    const snapshot = await sessions.startHost('房主');

    expect(startService).toHaveBeenCalledWith({ hostDisplayName: '房主' });
    expect(snapshot).toMatchObject({
      role: 'host',
      accessToken: 'lan:00000000-0000-4000-8000-000000000011',
      accessTokenExpiresAt: 43_201_000,
      joinIntent: {
        version: 1,
        mode: 'lan',
        endpoint,
        roomCode: '482731',
        inviteKey,
      },
    });
    await expect(sessions.issueTicket()).resolves.toEqual({
      endpoint,
      ticket,
      expiresInSeconds: 30,
    });
    expect(issueHostTicket).toHaveBeenCalledOnce();

    await sessions.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(sessions.currentIntent()).toBeNull();
  });

  it('joins with the invite key and reuses the initial guest ticket once', async () => {
    const request = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ticket,
            expiresInSeconds: 30,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );
    const sessions = createLanSessionController({
      fetch: request as unknown as typeof fetch,
      now: () => 2_000,
      randomUUID: () => '00000000-0000-4000-8000-000000000012',
    });
    const intent = {
      version: 1 as const,
      mode: 'lan' as const,
      endpoint,
      roomCode: '482731',
      inviteKey,
    };

    const snapshot = await sessions.startGuest('访客', intent);

    expect(snapshot).toMatchObject({
      role: 'guest',
      accessToken: 'lan:00000000-0000-4000-8000-000000000012',
      joinIntent: intent,
    });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('http://192.168.1.24:43120/v1/lite/session');
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${inviteKey}`,
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      version: 1,
      clientId: '00000000-0000-4000-8000-000000000012',
      displayName: '访客',
    });

    await expect(sessions.issueTicket()).resolves.toEqual({
      endpoint,
      ticket,
      expiresInSeconds: 30,
    });
    expect(request).toHaveBeenCalledOnce();
    await sessions.issueTicket();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
