import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PACKAGED_RENDERER_SCHEME = 'wo-app';
export const PACKAGED_RENDERER_HOST = 'bundle';
export const PACKAGED_RENDERER_ORIGIN = `${PACKAGED_RENDERER_SCHEME}://${PACKAGED_RENDERER_HOST}`;
export const PACKAGED_RENDERER_ENTRY = `${PACKAGED_RENDERER_ORIGIN}/index.html`;

interface RendererProtocol {
  registerSchemesAsPrivileged(
    schemes: {
      scheme: string;
      privileges: {
        standard: boolean;
        secure: boolean;
        supportFetchAPI: boolean;
      };
    }[],
  ): void;
  handle(
    scheme: string,
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
}

export interface PackagedRendererProtocolOptions {
  readonly bundleRoot: string;
  readonly contentSecurityPolicy: string;
  readonly fetchFile: (url: string) => Promise<Response>;
}

function response(
  status: number,
  contentSecurityPolicy: string,
  body: BodyInit | null = null,
): Response {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': contentSecurityPolicy,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

function bundleRelativePath(url: URL): string | null {
  if (
    url.protocol !== `${PACKAGED_RENDERER_SCHEME}:` ||
    url.hostname !== PACKAGED_RENDERER_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.includes('\\') ||
    decoded.includes('\0')
  ) {
    return null;
  }
  const path = decoded.slice(1);
  const segments = path.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    ) ||
    (path !== 'index.html' && !path.startsWith('assets/'))
  ) {
    return null;
  }
  return path;
}

export function registerPackagedRendererScheme(
  protocol: Pick<RendererProtocol, 'registerSchemesAsPrivileged'>,
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PACKAGED_RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function installPackagedRendererProtocol(
  protocol: Pick<RendererProtocol, 'handle'>,
  options: PackagedRendererProtocolOptions,
): void {
  const root = resolve(options.bundleRoot);
  protocol.handle(PACKAGED_RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response(405, options.contentSecurityPolicy, 'Method not allowed');
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return response(400, options.contentSecurityPolicy, 'Invalid request');
    }
    const relativePath = bundleRelativePath(url);
    if (relativePath === null) {
      return response(404, options.contentSecurityPolicy, 'Not found');
    }
    const path = resolve(root, relativePath);
    const contained = relative(root, path);
    if (
      contained === '' ||
      contained === '..' ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    ) {
      return response(404, options.contentSecurityPolicy, 'Not found');
    }

    let asset: Response;
    try {
      asset = await options.fetchFile(pathToFileURL(path).href);
    } catch {
      return response(404, options.contentSecurityPolicy, 'Not found');
    }
    if (!asset.ok || asset.body === null) {
      return response(404, options.contentSecurityPolicy, 'Not found');
    }
    const headers = new Headers(asset.headers);
    headers.set(
      'Cache-Control',
      relativePath === 'index.html'
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
    );
    headers.set('Content-Security-Policy', options.contentSecurityPolicy);
    headers.set('Content-Type', contentType(path));
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      status: asset.status,
      headers,
    });
  });
}
