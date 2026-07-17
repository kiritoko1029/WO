import { describe, expect, test } from 'vitest';

import { createLanFrameCodec } from '../src/lite/authenticated-frame.ts';

const inviteKey = Buffer.alloc(32, 7).toString('base64url');
const ticketA = Buffer.alloc(32, 8).toString('base64url');
const ticketB = Buffer.alloc(32, 9).toString('base64url');

function createBoundCodec(
  role: 'client' | 'server',
  connectionId: string,
  ticket = ticketA,
  key = inviteKey,
) {
  const codec = createLanFrameCodec(key, role);
  codec.bind(connectionId, ticket);
  return codec;
}

describe('LAN authenticated signaling frames', () => {
  test('authenticates both directions and rejects replay across connections', () => {
    const client = createBoundCodec('client', 'client-socket');
    const server = createBoundCodec('server', 'server-socket');

    const first = client.encode('client-socket', '{"request":1}');
    expect(server.decode('server-socket', first)).toBe('{"request":1}');
    const response = server.encode('server-socket', '{"ack":1}');
    expect(client.decode('client-socket', response)).toBe('{"ack":1}');

    const second = client.encode('client-socket', '{"request":2}');
    expect(server.decode('server-socket', second)).toBe('{"request":2}');
    expect(() => server.decode('server-socket', first)).toThrow(
      'sequence is out of order',
    );
    expect(() =>
      createBoundCodec('server', 'reconnected-socket', ticketB).decode(
        'reconnected-socket',
        first,
      ),
    ).toThrow('MAC is invalid');
  });

  test('rejects tampering, the wrong key, and non-canonical keys', () => {
    const client = createBoundCodec('client', 'client-socket');
    const frame = client.encode('client-socket', '{"request":1}');
    const decoded = JSON.parse(frame) as Record<string, unknown>;
    const tampered = JSON.stringify({ ...decoded, payload: '{"request":2}' });

    expect(() =>
      createBoundCodec('server', 'server-socket').decode(
        'server-socket',
        tampered,
      ),
    ).toThrow('MAC is invalid');
    expect(() =>
      createBoundCodec(
        'server',
        'wrong-key-socket',
        ticketA,
        Buffer.alloc(32, 10).toString('base64url'),
      ).decode('wrong-key-socket', frame),
    ).toThrow('MAC is invalid');
    expect(() => createLanFrameCodec('room-code-only', 'server')).toThrow(
      'credential is invalid',
    );
    const unbound = createLanFrameCodec(inviteKey, 'server');
    expect(() => unbound.encode('server-socket', '{}')).toThrow(
      'connection is not bound',
    );
    expect(() => unbound.bind('server-socket', 'not-a-ticket')).toThrow(
      'credential is invalid',
    );
  });

  test('uses canonical frames and rejects reflected, skipped, or oversized input', () => {
    const client = createBoundCodec('client', 'client-socket');
    const server = createBoundCodec('server', 'server-socket');
    const first = client.encode('client-socket', '{"request":1}');
    const second = client.encode('client-socket', '{"request":2}');
    const reflected = createBoundCodec('server', 'other-server-socket').encode(
      'other-server-socket',
      '{"request":1}',
    );

    expect(JSON.stringify(JSON.parse(first))).toBe(first);
    expect((JSON.parse(first) as { readonly mac: string }).mac).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    expect(() => server.decode('server-socket', second)).toThrow(
      'sequence is out of order',
    );
    expect(() => server.decode('server-socket', reflected)).toThrow(
      'MAC is invalid',
    );
    expect(() => server.decode('server-socket', 'x'.repeat(1_048_577))).toThrow(
      'frame is invalid',
    );
  });

  test('releases per-connection sequence state and clears all state', () => {
    const client = createBoundCodec('client', 'client-socket');
    const server = createBoundCodec('server', 'server-socket');

    expect(
      server.decode(
        'server-socket',
        client.encode('client-socket', '{"request":1}'),
      ),
    ).toBe('{"request":1}');
    client.release('client-socket');
    server.release('server-socket');
    client.bind('client-socket', ticketA);
    server.bind('server-socket', ticketA);
    expect(
      server.decode(
        'server-socket',
        client.encode('client-socket', '{"request":2}'),
      ),
    ).toBe('{"request":2}');

    client.clear();
    server.clear();
    client.bind('client-socket', ticketA);
    server.bind('server-socket', ticketA);
    expect(
      server.decode(
        'server-socket',
        client.encode('client-socket', '{"request":3}'),
      ),
    ).toBe('{"request":3}');
  });
});
