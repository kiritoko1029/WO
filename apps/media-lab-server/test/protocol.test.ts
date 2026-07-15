import { describe, expect, test } from 'vitest';

describe('media lab signaling protocol', () => {
  test('parses a bounded strict request', async () => {
    const { parseClientMessage } = await import('../src/protocol.js');
    const request = {
      type: 'request',
      id: 'request-1',
      method: 'createTransport',
      data: { direction: 'send' },
    };

    expect(parseClientMessage(JSON.stringify(request))).toEqual(request);
  });

  test.each([
    {
      type: 'request',
      id: 'request-1',
      method: 'createTransport',
      data: { direction: 'send', unexpected: true },
    },
    {
      type: 'request',
      id: 'x'.repeat(129),
      method: 'listProducers',
      data: {},
    },
    {
      type: 'request',
      id: 'spaces are forbidden',
      method: 'listProducers',
      data: {},
    },
  ])('rejects non-strict or unbounded requests', async (message) => {
    const { parseClientMessage } = await import('../src/protocol.js');

    expect(() => parseClientMessage(JSON.stringify(message))).toThrow(
      /invalid signaling message/i,
    );
  });

  test('rejects malformed JSON without leaking parser details', async () => {
    const { parseClientMessage } = await import('../src/protocol.js');

    expect(() => parseClientMessage('{')).toThrow('Invalid signaling message');
  });

  test('creates correlated strict acknowledgements and errors', async () => {
    const { ackMessageSchema, createAck, createError, errorMessageSchema } =
      await import('../src/protocol.js');

    expect(
      ackMessageSchema.parse(createAck('r-1', { id: 'transport-1' })),
    ).toEqual({
      type: 'ack',
      id: 'r-1',
      data: { id: 'transport-1' },
    });
    expect(
      errorMessageSchema.parse(createError('r-2', 'NOT_FOUND', 'Missing')),
    ).toEqual({
      type: 'error',
      id: 'r-2',
      error: { code: 'NOT_FOUND', message: 'Missing' },
    });
    expect(() =>
      ackMessageSchema.parse({
        type: 'ack',
        id: 'r-1',
        data: {},
        unexpected: true,
      }),
    ).toThrow();
  });

  test.each([
    ['getRouterRtpCapabilities', {}],
    ['listProducers', {}],
    ['connectTransport', { transportId: 'transport-1', dtlsParameters: {} }],
    [
      'produce',
      {
        transportId: 'transport-1',
        kind: 'video',
        rtpParameters: {},
        appData: { codec: 'video/VP8' },
      },
    ],
    [
      'consume',
      {
        transportId: 'transport-2',
        producerId: 'producer-1',
        rtpCapabilities: {},
      },
    ],
    ['resumeConsumer', { consumerId: 'consumer-1' }],
    ['close', { resourceType: 'producer', resourceId: 'producer-1' }],
  ])('accepts the %s request shape', async (method, data) => {
    const { parseClientMessage } = await import('../src/protocol.js');

    expect(
      parseClientMessage(
        JSON.stringify({ type: 'request', id: `id-${method}`, method, data }),
      ),
    ).toMatchObject({ method, data });
  });
});
