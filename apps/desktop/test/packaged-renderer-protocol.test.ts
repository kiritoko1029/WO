import { describe, expect, it, vi } from 'vitest';

import {
  PACKAGED_RENDERER_ENTRY,
  installPackagedRendererProtocol,
  registerPackagedRendererScheme,
} from '../src/main/packaged-renderer-protocol.js';

describe('packaged renderer protocol', () => {
  it('registers one standard secure scheme without bypassing CSP', () => {
    const registerSchemesAsPrivileged = vi.fn();

    registerPackagedRendererScheme({ registerSchemesAsPrivileged });

    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: 'wo-app',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
        },
      },
    ]);
    expect(
      JSON.stringify(registerSchemesAsPrivileged.mock.calls),
    ).not.toContain('bypassCSP');
  });

  it('serves only bundle files with exact security and MIME headers', async () => {
    let handler:
      ((request: Request) => Response | Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn(
        (
          _scheme: string,
          next: (request: Request) => Response | Promise<Response>,
        ) => {
          handler = next;
        },
      ),
    };
    const fetchFile = vi.fn(async () => {
      return new Response('<html>WO</html>', {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    });
    const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
    installPackagedRendererProtocol(protocol, {
      bundleRoot: '/opt/wo/out/renderer',
      contentSecurityPolicy: csp,
      fetchFile,
    });

    expect(protocol.handle).toHaveBeenCalledWith(
      'wo-app',
      expect.any(Function),
    );
    const result = await handler!(new Request(PACKAGED_RENDERER_ENTRY));
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('<html>WO</html>');
    expect(result.headers.get('content-security-policy')).toBe(csp);
    expect(result.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    );
    expect(fetchFile).toHaveBeenCalledWith(
      expect.stringMatching(/\/opt\/wo\/out\/renderer\/index\.html$/u),
    );
  });

  it.each([
    ['POST', PACKAGED_RENDERER_ENTRY],
    ['GET', 'wo-app://other/index.html'],
    ['GET', 'wo-app://bundle/index.html?debug=1'],
    ['GET', 'wo-app://bundle/other.html'],
    ['GET', 'wo-app://bundle/assets/%2Fetc'],
    ['GET', 'wo-app://bundle/assets/%5Csecret.js'],
    ['GET', 'wo-app://bundle/%2e%2e/secret.js'],
  ])('rejects %s %s without touching the filesystem', async (method, url) => {
    let handler:
      ((request: Request) => Response | Promise<Response>) | undefined;
    const fetchFile = vi.fn(async () => new Response('unexpected'));
    installPackagedRendererProtocol(
      {
        handle: (_scheme, next) => {
          handler = next;
        },
      },
      {
        bundleRoot: '/opt/wo/out/renderer',
        contentSecurityPolicy: "default-src 'self'",
        fetchFile,
      },
    );

    const request = new Request(url, { method });
    const result = await handler!(request);

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('supports HEAD without returning the asset body', async () => {
    let handler:
      ((request: Request) => Response | Promise<Response>) | undefined;
    installPackagedRendererProtocol(
      {
        handle: (_scheme, next) => {
          handler = next;
        },
      },
      {
        bundleRoot: '/opt/wo/out/renderer',
        contentSecurityPolicy: "default-src 'self'",
        fetchFile: async () =>
          new Response('console.info("WO")', { status: 200 }),
      },
    );

    const result = await handler!(
      new Request('wo-app://bundle/assets/index-ABC.js', { method: 'HEAD' }),
    );

    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(await result.text()).toBe('');
  });
});
