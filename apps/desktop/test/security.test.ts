import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  buildContentSecurityPolicy,
  createWindowOptions,
  installContentSecurityPolicy,
  installMediaPermissionPolicy,
  installWindowSecurity,
  isAllowedRendererUrl,
  type PermissionSession,
} from '../src/main/window-security.js';

describe('desktop window security', () => {
  it('uses the hardened Electron renderer preferences and stable dimensions', () => {
    const windowOptions = createWindowOptions('C:\\app\\preload.js');

    expect(windowOptions).toMatchObject({
      width: 1_280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        preload: 'C:\\app\\preload.js',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
  });

  it('allows only the exact configured renderer entry', () => {
    expect(
      isAllowedRendererUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:5173/'),
    ).toBe(true);
    expect(
      isAllowedRendererUrl(
        'http://127.0.0.1:5173/other',
        'http://127.0.0.1:5173/',
      ),
    ).toBe(false);
    expect(
      isAllowedRendererUrl(
        'https://attacker.invalid/',
        'http://127.0.0.1:5173/',
      ),
    ).toBe(false);
    expect(
      isAllowedRendererUrl(
        'file:///C:/app/out/renderer/index.html',
        'file:///C:/app/out/renderer/index.html',
      ),
    ).toBe(true);
    expect(
      isAllowedRendererUrl(
        'file:///C:/app/out/renderer/other.html',
        'file:///C:/app/out/renderer/index.html',
      ),
    ).toBe(false);
  });

  it('denies new windows and navigation away from the entry', () => {
    let openHandler: (() => { action: string }) | undefined;
    let navigationHandler:
      ((event: { preventDefault(): void }, url: string) => void) | undefined;
    const webContents = {
      setWindowOpenHandler: vi.fn((handler) => {
        openHandler = handler;
      }),
      on: vi.fn((event, handler) => {
        if (event === 'will-navigate') navigationHandler = handler;
      }),
    };

    installWindowSecurity(webContents, 'app://desktop/index.html');

    expect(openHandler?.()).toEqual({ action: 'deny' });
    const allowed = { preventDefault: vi.fn() };
    navigationHandler?.(allowed, 'app://desktop/index.html');
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    const denied = { preventDefault: vi.fn() };
    navigationHandler?.(denied, 'https://attacker.invalid');
    expect(denied.preventDefault).toHaveBeenCalledOnce();
  });

  it('builds a CSP with only local assets and the exact realtime WSS origin', () => {
    const csp = buildContentSecurityPolicy('wss://rtc.example.cn');

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("connect-src 'self' wss://rtc.example.cn");
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('http:');
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it.each(['index.html', 'index.acceptance.html'])(
    'pins the inline theme bootstrap in the response CSP for %s',
    async (name) => {
      const source = await readFile(
        new URL(`../src/renderer/${name}`, import.meta.url),
        'utf8',
      );
      const script = source.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
      const policy = buildContentSecurityPolicy('wss://rtc.example.cn');
      expect(source).not.toContain('http-equiv="Content-Security-Policy"');
      expect(script).toBeDefined();
      const hash = createHash('sha256').update(script!).digest('base64');
      expect(policy).toContain(`'sha256-${hash}'`);
    },
  );

  it('injects the CSP only into the exact main renderer document', () => {
    let listener:
      | ((
          details: {
            url: string;
            resourceType: string;
            responseHeaders?: Record<string, string[]>;
          },
          callback: (result: {
            responseHeaders?: Record<string, string[]>;
          }) => void,
        ) => void)
      | undefined;
    const session = {
      webRequest: {
        onHeadersReceived: vi.fn((_filter, handler) => {
          listener = handler;
        }),
      },
    };
    const entry = 'file:///C:/app/out/renderer/index.html';
    const csp = buildContentSecurityPolicy('wss://rtc.example.cn');
    installContentSecurityPolicy(session, entry, csp);

    const callback = vi.fn();
    listener?.(
      {
        url: entry,
        resourceType: 'mainFrame',
        responseHeaders: {
          Existing: ['value'],
          'content-security-policy': ["default-src 'none'"],
        },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        Existing: ['value'],
        'Content-Security-Policy': [csp],
      },
    });

    callback.mockClear();
    listener?.(
      {
        url: 'file:///C:/app/out/renderer/other.html',
        resourceType: 'mainFrame',
        responseHeaders: { Existing: ['value'] },
      },
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: { Existing: ['value'] },
    });
  });

  it('enables the sandbox and installs only an explicitly configured extra-CA verifier', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );

    expect(source.indexOf('app.enableSandbox()')).toBeGreaterThanOrEqual(0);
    expect(source.indexOf('app.enableSandbox()')).toBeLessThan(
      source.indexOf('app.whenReady()'),
    );
    expect(source).not.toContain('setCertificateVerifyProc');
    expect(source).not.toContain('certificate-error');
    expect(source).toMatch(
      /const extraCaCertificates = installExtraCaFromEnvironment\(process\.env\);\s+if \(extraCaCertificates\.length > 0\) \{\s+installExtraCaCertificateVerifier\(session\.defaultSession,/u,
    );
    expect(
      source.lastIndexOf(
        'installExtraCaCertificateVerifier(session.defaultSession',
      ),
    ).toBeLessThan(source.indexOf('mainWindow = createMainWindow();'));
    expect(source).toContain('createCaptureSourceBroker');
    expect(source).toContain('createCaptureSourceService');
    expect(source).toContain('installDisplayMediaHandler');
    expect(source).toContain('createScreenPermissionService');
    expect(source).toContain("webContents.on('did-start-navigation'");
    expect(source).toContain("webContents.once('destroyed'");
  });

  it('allows only trusted main-frame audio, display capture, and speaker permissions', () => {
    let requestHandler:
      | ((
          webContents: { getURL(): string },
          permission: string,
          callback: (allowed: boolean) => void,
          details: {
            mediaTypes?: readonly string[];
            requestingUrl?: string;
            isMainFrame?: boolean;
          },
        ) => void)
      | undefined;
    let checkHandler:
      | ((
          webContents: { getURL(): string } | null,
          permission: string,
          requestingOrigin: string,
          details: {
            mediaType?: string;
            requestingUrl?: string;
            isMainFrame?: boolean;
          },
        ) => boolean)
      | undefined;
    const session = {
      setPermissionRequestHandler: vi.fn((handler) => {
        requestHandler = handler;
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        checkHandler = handler;
      }),
    };
    const entry = 'http://127.0.0.1:5173/';
    const trusted = { getURL: () => entry };
    installMediaPermissionPolicy(session, entry);

    const callback = vi.fn();
    requestHandler?.(trusted, 'media', callback, {
      mediaTypes: ['audio'],
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    requestHandler?.(trusted, 'speaker-selection', callback, {
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    requestHandler?.(trusted, 'display-capture', callback, {
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    requestHandler?.(trusted, 'fullscreen', callback, {
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    requestHandler?.(trusted, 'media', callback, {
      mediaTypes: [],
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    requestHandler?.(trusted, 'media', callback, {
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenLastCalledWith(true);
    for (const [contents, permission, details] of [
      [
        trusted,
        'media',
        { mediaTypes: ['video'], requestingUrl: entry, isMainFrame: true },
      ],
      [
        trusted,
        'media',
        {
          mediaTypes: ['audio', 'video'],
          requestingUrl: entry,
          isMainFrame: true,
        },
      ],
      [
        trusted,
        'display-capture',
        { requestingUrl: entry, isMainFrame: false },
      ],
      // Fullscreen must stay restricted to the trusted main frame.
      [
        trusted,
        'fullscreen',
        { requestingUrl: entry, isMainFrame: false },
      ],
      [
        { getURL: () => 'https://attacker.invalid/' },
        'fullscreen',
        { requestingUrl: entry, isMainFrame: true },
      ],
      [
        trusted,
        'media',
        { mediaTypes: [], requestingUrl: entry, isMainFrame: false },
      ],
      [
        trusted,
        'media',
        { mediaTypes: ['audio'], requestingUrl: entry, isMainFrame: false },
      ],
      [
        { getURL: () => 'https://attacker.invalid/' },
        'media',
        { mediaTypes: ['audio'], requestingUrl: entry, isMainFrame: true },
      ],
      [
        { getURL: () => 'https://attacker.invalid/' },
        'media',
        { mediaTypes: [], requestingUrl: entry, isMainFrame: true },
      ],
      [
        trusted,
        'media',
        {
          mediaTypes: ['audio'],
          requestingUrl: 'https://attacker.invalid/',
          isMainFrame: true,
        },
      ],
    ] as const) {
      requestHandler?.(contents, permission, callback, details);
      expect(callback).toHaveBeenLastCalledWith(false);
    }

    expect(
      checkHandler?.(trusted, 'media', new URL(entry).origin, {
        mediaType: 'audio',
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      checkHandler?.(trusted, 'speaker-selection', new URL(entry).origin, {
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      checkHandler?.(trusted, 'display-capture', new URL(entry).origin, {
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      checkHandler?.(trusted, 'fullscreen', new URL(entry).origin, {
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(true);
    expect(
      checkHandler?.(trusted, 'display-capture', new URL(entry).origin, {
        requestingUrl: entry,
        isMainFrame: false,
      }),
    ).toBe(false);
    // Fullscreen is only granted to the trusted main frame, never subframes.
    expect(
      checkHandler?.(trusted, 'fullscreen', new URL(entry).origin, {
        requestingUrl: entry,
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      checkHandler?.(
        { getURL: () => 'https://attacker.invalid/' },
        'display-capture',
        'https://attacker.invalid',
        { requestingUrl: entry, isMainFrame: true },
      ),
    ).toBe(false);
    expect(
      checkHandler?.(trusted, 'media', new URL(entry).origin, {
        mediaType: 'video',
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      checkHandler?.(trusted, 'media', new URL(entry).origin, {
        mediaType: 'audio',
        requestingUrl: entry,
        isMainFrame: false,
      }),
    ).toBe(false);
    expect(
      checkHandler?.(trusted, 'geolocation', new URL(entry).origin, {
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(false);
    expect(
      checkHandler?.(null, 'media', new URL(entry).origin, {
        mediaType: 'audio',
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(false);
  });

  it('accepts trusted packaged file main frames without relying on a file origin', () => {
    let requestHandler:
      | Parameters<PermissionSession['setPermissionRequestHandler']>[0]
      | undefined;
    let checkHandler:
      Parameters<PermissionSession['setPermissionCheckHandler']>[0] | undefined;
    const session = {
      setPermissionRequestHandler: vi.fn((handler) => {
        requestHandler = handler;
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        checkHandler = handler;
      }),
    };
    const entry = 'file:///C:/app/out/renderer/index.html';
    const contents = { getURL: () => entry };
    installMediaPermissionPolicy(session, entry);

    const callback = vi.fn();
    requestHandler?.(contents, 'media', callback, {
      mediaTypes: ['audio'],
      requestingUrl: entry,
      isMainFrame: true,
    });
    expect(callback).toHaveBeenCalledWith(true);
    expect(
      checkHandler?.(contents, 'speaker-selection', 'file://', {
        requestingUrl: entry,
        isMainFrame: true,
      }),
    ).toBe(true);
  });
});
