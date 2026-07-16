import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  buildContentSecurityPolicy,
  createWindowOptions,
  installContentSecurityPolicy,
  installWindowSecurity,
  isAllowedRendererUrl,
} from '../src/main/window-security.js';

describe('desktop window security', () => {
  it('uses the hardened Electron renderer preferences and stable dimensions', () => {
    const windowOptions = createWindowOptions('C:\\app\\preload.js');

    expect(windowOptions).toMatchObject({
      width: 920,
      height: 640,
      minWidth: 720,
      minHeight: 560,
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
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("connect-src 'self' wss://rtc.example.cn");
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('http:');
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

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

  it('enables the app sandbox before readiness and never installs a certificate bypass', async () => {
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
  });
});
