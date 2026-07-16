export interface ResponseSchema<Result> {
  parse(input: unknown): Result;
}

export interface MainHttpPostRequest<Result> {
  readonly path: string;
  readonly body?: unknown;
  readonly bearerToken?: string;
  readonly responseSchema: ResponseSchema<Result>;
}

export interface MainHttpClient {
  post<Result>(request: MainHttpPostRequest<Result>): Promise<Result>;
}

export interface MainHttpClientOptions {
  readonly apiOrigin: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class DesktopHttpError extends Error {
  readonly status: number | null;
  readonly code: string;

  constructor(
    status: number | null,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DesktopHttpError';
    this.status = status;
    this.code = code;
  }
}

function parseApiOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('API origin must be a canonical HTTPS origin');
  }
  return url.origin;
}

function positiveBoundedInteger(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function responseLength(response: Response): number | null {
  const header = response.headers.get('content-length');
  if (header === null || !/^\d+$/u.test(header)) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

function serverError(input: unknown): { code: string; message: string } | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('error' in input) ||
    typeof input.error !== 'object' ||
    input.error === null
  ) {
    return null;
  }
  const error = input.error as Record<string, unknown>;
  if (
    typeof error.code !== 'string' ||
    !/^[A-Z0-9_]{1,128}$/u.test(error.code) ||
    typeof error.message !== 'string' ||
    error.message.trim().length === 0 ||
    error.message.length > 256
  ) {
    return null;
  }
  return { code: error.code, message: error.message };
}

function cancelBody(response: Response, controller: AbortController): void {
  let cancellation: Promise<void> | undefined;
  try {
    cancellation = response.body?.cancel();
  } catch {
    // Abort below remains the authoritative transport cleanup.
  }
  controller.abort();
  void cancellation?.catch(() => undefined);
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
): void {
  let cancellation: Promise<void> | undefined;
  try {
    cancellation = reader.cancel();
  } catch {
    // Abort below remains the authoritative transport cleanup.
  }
  controller.abort();
  void cancellation?.catch(() => undefined);
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<Uint8Array> {
  if (response.body === null) {
    cancelBody(response, controller);
    throw new DesktopHttpError(
      response.status,
      'INVALID_RESPONSE',
      'The server response could not be read',
    );
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    cancelBody(response, controller);
    throw new DesktopHttpError(
      response.status,
      'INVALID_RESPONSE',
      'The server response could not be read',
      { cause: error },
    );
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError('Invalid response chunk');
      }
      if (result.value.byteLength > maximumBytes - byteLength) {
        cancelReader(reader, controller);
        throw new DesktopHttpError(
          response.status,
          'RESPONSE_TOO_LARGE',
          'The server response was too large',
        );
      }
      byteLength += result.value.byteLength;
      if (result.value.byteLength > 0) chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof DesktopHttpError) throw error;
    const timedOut = controller.signal.aborted;
    cancelReader(reader, controller);
    if (timedOut) {
      throw new DesktopHttpError(
        null,
        'REQUEST_TIMEOUT',
        'The server request timed out',
        { cause: error },
      );
    }
    throw new DesktopHttpError(
      response.status,
      'INVALID_RESPONSE',
      'The server response could not be read',
      { cause: error },
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The response has already been consumed or cancelled.
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createMainHttpClient(
  options: MainHttpClientOptions,
): Readonly<MainHttpClient> {
  const apiOrigin = parseApiOrigin(options.apiOrigin);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveBoundedInteger(
    options.timeoutMs ?? 10_000,
    'timeoutMs',
    60_000,
  );
  const maxResponseBytes = positiveBoundedInteger(
    options.maxResponseBytes ?? 256 * 1_024,
    'maxResponseBytes',
    2 * 1_024 * 1_024,
  );

  return Object.freeze({
    async post<Result>(request: MainHttpPostRequest<Result>): Promise<Result> {
      if (!request.path.startsWith('/') || request.path.startsWith('//')) {
        throw new TypeError('HTTP path must be application-relative');
      }
      const requestUrl = new URL(request.path, `${apiOrigin}/`);
      if (requestUrl.origin !== apiOrigin || requestUrl.hash !== '') {
        throw new TypeError('HTTP path escapes the configured API origin');
      }

      const headers: Record<string, string> = {};
      if (request.bearerToken !== undefined) {
        if (
          request.bearerToken.length === 0 ||
          request.bearerToken.length > 4_096 ||
          /\s/u.test(request.bearerToken)
        ) {
          throw new TypeError('Invalid access token');
        }
        headers.authorization = `Bearer ${request.bearerToken}`;
      }
      let body: string | undefined;
      if (request.body !== undefined) {
        body = JSON.stringify(request.body);
        if (
          body === undefined ||
          Buffer.byteLength(body, 'utf8') > 64 * 1_024
        ) {
          throw new TypeError('Request body is invalid');
        }
        headers['content-type'] = 'application/json';
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const execute = async (): Promise<Result> => {
        let response: Response;
        try {
          response = await fetchImplementation(requestUrl.href, {
            method: 'POST',
            headers,
            body,
            redirect: 'error',
            cache: 'no-store',
            credentials: 'omit',
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new DesktopHttpError(
              null,
              'REQUEST_TIMEOUT',
              'The server request timed out',
              { cause: error },
            );
          }
          throw new DesktopHttpError(
            null,
            'NETWORK_ERROR',
            'The server is unavailable',
            { cause: error },
          );
        }

        let responseOrigin: string;
        try {
          responseOrigin = new URL(response.url).origin;
        } catch {
          responseOrigin = '';
        }
        if (responseOrigin !== apiOrigin) {
          cancelBody(response, controller);
          throw new DesktopHttpError(
            null,
            'UNTRUSTED_RESPONSE_ORIGIN',
            'The server response origin was rejected',
          );
        }
        if ((responseLength(response) ?? 0) > maxResponseBytes) {
          cancelBody(response, controller);
          throw new DesktopHttpError(
            response.status,
            'RESPONSE_TOO_LARGE',
            'The server response was too large',
          );
        }

        const bytes = await readBoundedResponse(
          response,
          maxResponseBytes,
          controller,
        );
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          );
        } catch (error) {
          throw new DesktopHttpError(
            response.status,
            'INVALID_RESPONSE',
            'The server returned an invalid response',
            { cause: error },
          );
        }

        if (!response.ok) {
          const parsed = serverError(decoded);
          throw new DesktopHttpError(
            response.status,
            parsed?.code ?? 'HTTP_ERROR',
            parsed?.message ?? 'The server rejected the request',
          );
        }
        try {
          return request.responseSchema.parse(decoded);
        } catch (error) {
          throw new DesktopHttpError(
            response.status,
            'INVALID_RESPONSE',
            'The server returned an invalid response',
            { cause: error },
          );
        }
      };
      try {
        return await execute();
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
