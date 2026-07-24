import { randomUUID } from 'node:crypto';

import {
  PACKAGED_RENDERER_HOST,
  PACKAGED_RENDERER_ORIGIN,
  PACKAGED_RENDERER_SCHEME,
} from './packaged-renderer-protocol.js';

export interface CaptureSource {
  readonly id: string;
  readonly name: string;
}

export interface CaptureSourceToken {
  readonly token: string;
  readonly name: string;
}

export interface CaptureSourceBroker<Source extends CaptureSource> {
  replaceAvailable(
    webContentsId: number,
    sources: readonly Source[],
  ): readonly CaptureSourceToken[];
  select(webContentsId: number, token: string): void;
  consumeSelected(webContentsId: number): Source;
  clear(webContentsId: number): void;
}

export interface CaptureSourceBrokerOptions {
  readonly now?: () => number;
  readonly randomToken?: () => string;
  readonly tokenTtlMs?: number;
}

interface TokenEntry<Source> {
  readonly source: Source;
  readonly expiresAtMs: number;
}

interface CaptureContext<Source> {
  readonly available: Map<string, TokenEntry<Source>>;
  selectedToken: string | null;
}

const CAPTURE_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_TOKEN_TTL_MS = 30_000;

export function parseCaptureSourceToken(input: unknown): string {
  if (typeof input !== 'string' || !CAPTURE_TOKEN.test(input)) {
    throw new TypeError('Invalid capture source token');
  }
  return input;
}

function assertWebContentsId(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Invalid WebContents ID');
  }
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) throw new RangeError('Invalid capture clock');
  return value;
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? ' '
        : character;
    })
    .join('');
}

function sanitizedName(value: string, sourceId: string): string {
  const normalized = replaceControlCharacters(value)
    .replace(/\s+/gu, ' ')
    .trim();
  const bounded = [...normalized].slice(0, 256).join('');
  if (bounded.length > 0) return bounded;
  return sourceId.startsWith('screen:') ? 'Unnamed screen' : 'Unnamed window';
}

export function createCaptureSourceBroker<Source extends CaptureSource>(
  options: CaptureSourceBrokerOptions = {},
): CaptureSourceBroker<Source> {
  const now = options.now ?? Date.now;
  const makeToken = options.randomToken ?? randomUUID;
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0) {
    throw new RangeError('Capture token TTL must be a positive integer');
  }
  const contexts = new Map<number, CaptureContext<Source>>();

  return Object.freeze({
    replaceAvailable(webContentsId: number, sources: readonly Source[]) {
      assertWebContentsId(webContentsId);
      const currentTimeMs = readNow(now);
      const expiresAtMs = currentTimeMs + tokenTtlMs;
      const previous = contexts.get(webContentsId);
      const previousSelectedToken = previous?.selectedToken ?? null;
      const previousSelectedEntry =
        previousSelectedToken === null
          ? undefined
          : previous?.available.get(previousSelectedToken);
      const reusableSelectedSourceId =
        previousSelectedEntry !== undefined &&
        previousSelectedEntry.expiresAtMs > currentTimeMs
          ? previousSelectedEntry.source.id
          : null;
      const available = new Map<string, TokenEntry<Source>>();
      const sourceIds = new Set<string>();
      const summaries = sources.map((source: Source) => {
        if (
          source.id.length === 0 ||
          source.id.length > 512 ||
          sourceIds.has(source.id)
        ) {
          throw new TypeError('Invalid capture source ID');
        }
        sourceIds.add(source.id);
        const token =
          source.id === reusableSelectedSourceId &&
          previousSelectedToken !== null
            ? previousSelectedToken
            : makeToken();
        if (!CAPTURE_TOKEN.test(token) || available.has(token)) {
          throw new TypeError('Invalid capture source token');
        }
        const name = sanitizedName(source.name, source.id);
        available.set(token, { source, expiresAtMs });
        return Object.freeze({ token, name });
      });
      const selectedToken =
        reusableSelectedSourceId !== null &&
        previousSelectedToken !== null &&
        available.get(previousSelectedToken)?.source.id ===
          reusableSelectedSourceId
          ? previousSelectedToken
          : null;
      contexts.set(webContentsId, { available, selectedToken });
      return Object.freeze(summaries);
    },
    select(webContentsId: number, token: string) {
      assertWebContentsId(webContentsId);
      parseCaptureSourceToken(token);
      const context = contexts.get(webContentsId);
      if (context === undefined) {
        throw new Error('Capture source token was not enumerated');
      }
      const entry = context.available.get(token);
      if (entry === undefined) {
        throw new Error('Capture source token was not enumerated');
      }
      if (entry.expiresAtMs <= readNow(now)) {
        context.available.delete(token);
        if (context.selectedToken === token) context.selectedToken = null;
        throw new Error('Capture source token expired');
      }
      context.selectedToken = token;
    },
    consumeSelected(webContentsId: number) {
      assertWebContentsId(webContentsId);
      const context = contexts.get(webContentsId);
      if (context === undefined) {
        throw new Error('Capture source context is unavailable');
      }
      const token = context.selectedToken;
      if (token === null) throw new Error('No capture source is selected');
      const entry = context.available.get(token);
      contexts.delete(webContentsId);
      if (entry === undefined) throw new Error('No capture source is selected');
      if (entry.expiresAtMs <= readNow(now)) {
        throw new Error('Capture source token expired');
      }
      return entry.source;
    },
    clear(webContentsId: number) {
      contexts.delete(webContentsId);
    },
  });
}

export interface DisplayCaptureRequest {
  readonly frame: unknown;
  readonly securityOrigin: string;
  readonly videoRequested: boolean;
  readonly audioRequested: boolean;
  readonly userGesture: boolean;
}

export interface DisplayCapturePolicy {
  readonly mainFrame: unknown;
  readonly rendererEntry: string;
}

export function captureSecurityOrigin(rendererEntry: string): string {
  const url = new URL(rendererEntry);
  if (url.protocol === 'file:') return 'file://';
  if (
    url.protocol === `${PACKAGED_RENDERER_SCHEME}:` &&
    url.hostname === PACKAGED_RENDERER_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  ) {
    return PACKAGED_RENDERER_ORIGIN;
  }
  return url.origin;
}

function canonicalDisplaySecurityOrigin(value: string): string | null {
  if (value === 'file://' || value === 'file:///') return 'file://';
  if (
    value === PACKAGED_RENDERER_ORIGIN ||
    value === `${PACKAGED_RENDERER_ORIGIN}/`
  ) {
    return PACKAGED_RENDERER_ORIGIN;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isDisplayCaptureRequestAllowed(
  request: DisplayCaptureRequest,
  policy: DisplayCapturePolicy,
): boolean {
  if (
    request.frame !== policy.mainFrame ||
    typeof request.frame !== 'object' ||
    request.frame === null ||
    !('url' in request.frame)
  ) {
    return false;
  }
  // Compare at origin level rather than exact-string matching. Vite dev mode
  // serves on http://localhost:5173/ while electron-vite reports the renderer
  // entry as http://127.0.0.1:5173/; the existing origin normalization (also
  // used for securityOrigin below) treats those as equivalent.
  const frameUrl = String(request.frame.url);
  if (
    captureSecurityOrigin(frameUrl) !==
    captureSecurityOrigin(policy.rendererEntry)
  ) {
    return false;
  }
  return (
    canonicalDisplaySecurityOrigin(request.securityOrigin) ===
      captureSecurityOrigin(policy.rendererEntry) &&
    request.videoRequested &&
    request.userGesture
  );
}
