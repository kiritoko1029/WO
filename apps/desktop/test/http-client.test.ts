import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMainHttpClient,
  DesktopHttpError,
} from '../src/main/http-client.js';

const unknownSchema = { parse: (input: unknown) => input };
const valueSchema = {
  parse: (input: unknown): { value: string } => {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('value' in input) ||
      typeof input.value !== 'string'
    ) {
      throw new TypeError('invalid response');
    }
    return { value: input.value };
  },
};

afterEach(() => vi.useRealTimers());

function jsonResponse(
  body: unknown,
  options: { readonly status?: number; readonly url?: string } = {},
): Response {
  const response = new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(response, 'url', {
    value: options.url ?? 'https://rtc.example.cn/v1/test',
  });
  return response;
}

function readerResponse(
  chunks: readonly Uint8Array[],
  options: {
    readonly headers?: Record<string, string>;
    readonly readError?: Error;
    readonly status?: number;
    readonly url?: string;
  } = {},
) {
  let index = 0;
  const cancel = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn();
  const read = vi.fn(async () => {
    if (options.readError) throw options.readError;
    const value = chunks[index++];
    return value === undefined
      ? { done: true as const, value: undefined }
      : { done: false as const, value };
  });
  const arrayBuffer = vi.fn(() => {
    throw new Error('arrayBuffer must never be used');
  });
  const response = {
    url: options.url ?? 'https://rtc.example.cn/v1/test',
    status: options.status ?? 200,
    ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
    headers: new Headers(options.headers),
    body: {
      cancel,
      getReader: () => ({ read, cancel, releaseLock }),
    },
    arrayBuffer,
  } as unknown as Response;
  return { arrayBuffer, cancel, read, releaseLock, response };
}

describe('main-process HTTP client', () => {
  it.each([
    'http://rtc.example.cn',
    'https://rtc.example.cn/api',
    'https://user@rtc.example.cn',
    'https://rtc.example.cn?query=1',
  ])('rejects a non-canonical HTTPS API origin: %s', (origin) => {
    expect(() =>
      createMainHttpClient({ apiOrigin: origin, fetch: vi.fn() }),
    ).toThrow(TypeError);
  });

  it('posts JSON with redirects disabled and validates the bounded response', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { value: 'ok' },
          { url: 'https://rtc.example.cn/v1/test' },
        ),
      );
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch,
    });

    await expect(
      client.post({
        path: '/v1/test',
        body: { input: true },
        responseSchema: valueSchema,
      }),
    ).resolves.toEqual({ value: 'ok' });

    expect(fetch).toHaveBeenCalledWith(
      'https://rtc.example.cn/v1/test',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: '{"input":true}',
        headers: { 'content-type': 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects a response whose final origin differs from startup configuration', async () => {
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { value: 'ok' },
            { url: 'https://attacker.invalid/v1/test' },
          ),
        ),
    });

    await expect(
      client.post({
        path: '/v1/test',
        responseSchema: valueSchema,
      }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_RESPONSE_ORIGIN' });
  });

  it('cancels and aborts an untrusted-origin response before reading it', async () => {
    let requestSignal: AbortSignal | undefined;
    const streamed = readerResponse([new Uint8Array([1, 2, 3])], {
      url: 'https://attacker.invalid/v1/test',
    });
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return streamed.response;
      }),
    });

    await expect(
      client.post({ path: '/v1/test', responseSchema: unknownSchema }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_RESPONSE_ORIGIN' });
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(streamed.read).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('rejects declared and actual response bodies above the configured limit', async () => {
    const declared = jsonResponse(
      { value: 'ok' },
      { url: 'https://rtc.example.cn/v1/test' },
    );
    declared.headers.set('content-length', '65');
    const first = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn().mockResolvedValue(declared),
      maxResponseBytes: 64,
    });
    await expect(
      first.post({ path: '/v1/test', responseSchema: unknownSchema }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });

    const actual = jsonResponse(
      { value: 'this response is larger than sixteen bytes' },
      { url: 'https://rtc.example.cn/v1/test' },
    );
    const second = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn().mockResolvedValue(actual),
      maxResponseBytes: 16,
    });
    await expect(
      second.post({ path: '/v1/test', responseSchema: unknownSchema }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('streams a chunked decoded response without calling arrayBuffer', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ value: 'ok' }));
    const streamed = readerResponse(
      [encoded.slice(0, 4), encoded.slice(4, 9), encoded.slice(9)],
      { headers: { 'content-encoding': 'gzip' } },
    );
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn().mockResolvedValue(streamed.response),
      maxResponseBytes: encoded.byteLength,
    });

    await expect(
      client.post({ path: '/v1/test', responseSchema: valueSchema }),
    ).resolves.toEqual({ value: 'ok' });
    expect(streamed.read).toHaveBeenCalledTimes(4);
    expect(streamed.releaseLock).toHaveBeenCalledOnce();
    expect(streamed.arrayBuffer).not.toHaveBeenCalled();
  });

  it('cancels and aborts immediately when decoded chunks exceed the limit', async () => {
    let requestSignal: AbortSignal | undefined;
    const streamed = readerResponse(
      [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)],
      { headers: { 'content-encoding': 'gzip' } },
    );
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return streamed.response;
      }),
      maxResponseBytes: 16,
    });

    await expect(
      client.post({ path: '/v1/test', responseSchema: unknownSchema }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(streamed.read).toHaveBeenCalledTimes(2);
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
    expect(streamed.arrayBuffer).not.toHaveBeenCalled();
  });

  it('fails safely when a response has no readable body', async () => {
    const arrayBuffer = vi.fn();
    const response = {
      url: 'https://rtc.example.cn/v1/test',
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer,
    } as unknown as Response;
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn().mockResolvedValue(response),
    });

    await expect(
      client.post({ path: '/v1/test', responseSchema: unknownSchema }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('cancels and aborts a reader failure without exposing its details', async () => {
    let requestSignal: AbortSignal | undefined;
    const streamed = readerResponse([], {
      readError: new Error('decoded stream token=secret'),
    });
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return streamed.response;
      }),
    });

    await expect(
      client.post({ path: '/v1/test', responseSchema: unknownSchema }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'The server response could not be read',
    });
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(true);
    expect(streamed.arrayBuffer).not.toHaveBeenCalled();
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const cancel = vi.fn().mockResolvedValue(undefined);
      return {
        url: 'https://rtc.example.cn/v1/test',
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: {
          getReader: () => ({
            cancel,
            releaseLock: vi.fn(),
            read: () =>
              new Promise((_resolve, reject) => {
                requestSignal?.addEventListener('abort', () => {
                  reject(new DOMException('aborted', 'AbortError'));
                });
              }),
          }),
        },
        arrayBuffer: vi.fn(() => {
          throw new Error('arrayBuffer must never be used');
        }),
      } as unknown as Response;
    });
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch,
      timeoutMs: 25,
    });

    const result = client.post({
      path: '/v1/test',
      responseSchema: unknownSchema,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(26);

    expect(requestSignal?.aborted).toBe(true);
    await rejection;
  });

  it('returns a sanitized server error without reflecting request secrets', async () => {
    const client = createMainHttpClient({
      apiOrigin: 'https://rtc.example.cn',
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'INVALID_CREDENTIALS',
              message: 'Invalid email or password',
            },
          },
          { status: 401, url: 'https://rtc.example.cn/v1/auth/login' },
        ),
      ),
    });

    const promise = client.post({
      path: '/v1/auth/login',
      body: { password: 'do-not-reflect-this' },
      responseSchema: unknownSchema,
    });

    await expect(promise).rejects.toBeInstanceOf(DesktopHttpError);
    await expect(promise).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
    await expect(promise).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('do-not-reflect-this'),
    );
  });
});
