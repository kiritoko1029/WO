import type { BrowserWindowConstructorOptions } from 'electron';

export interface SecurityWebContents {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault(): void }, url: string) => void,
  ): void;
}

interface HeadersReceivedDetails {
  readonly url: string;
  readonly resourceType: string;
  readonly responseHeaders?: Record<string, string | string[]>;
}

export interface SecuritySession {
  readonly webRequest: {
    onHeadersReceived(
      filter: { readonly urls: string[] },
      listener: (
        details: HeadersReceivedDetails,
        callback: (result: {
          readonly responseHeaders?: Record<string, string | string[]>;
        }) => void,
      ) => void,
    ): void;
  };
}

interface PermissionWebContents {
  getURL(): string;
}

export interface PermissionSession {
  setPermissionRequestHandler(
    handler: (
      webContents: PermissionWebContents,
      permission: string,
      callback: (allowed: boolean) => void,
      details: {
        readonly mediaTypes?: readonly string[];
        readonly requestingUrl?: string;
        readonly isMainFrame?: boolean;
      },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: PermissionWebContents | null,
      permission: string,
      requestingOrigin: string,
      details: {
        readonly mediaType?: string;
        readonly requestingUrl?: string;
        readonly isMainFrame?: boolean;
      },
    ) => boolean,
  ): void;
}

export function createWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 560,
    title: 'WO',
    backgroundColor: '#f5f6f7',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  };
}

export function isAllowedRendererUrl(
  candidate: string,
  entry: string,
): boolean {
  try {
    return new URL(candidate).href === new URL(entry).href;
  } catch {
    return false;
  }
}

export function installWindowSecurity(
  webContents: SecurityWebContents,
  rendererEntry: string,
): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url, rendererEntry)) {
      event.preventDefault();
    }
  });
}

function trustedContents(
  webContents: PermissionWebContents | null,
  rendererEntry: string,
): boolean {
  return (
    webContents !== null &&
    isAllowedRendererUrl(webContents.getURL(), rendererEntry)
  );
}

export function installMediaPermissionPolicy(
  session: PermissionSession,
  rendererEntry: string,
): void {
  session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const trusted =
        trustedContents(webContents, rendererEntry) &&
        details.requestingUrl === rendererEntry &&
        details.isMainFrame === true;
      const audioOnly =
        permission === 'media' &&
        details.mediaTypes?.length === 1 &&
        details.mediaTypes[0] === 'audio';
      callback(trusted && (audioOnly || permission === 'speaker-selection'));
    },
  );
  session.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) => {
      if (
        !trustedContents(webContents, rendererEntry) ||
        details.requestingUrl !== rendererEntry ||
        details.isMainFrame !== true
      ) {
        return false;
      }
      return (
        permission === 'speaker-selection' ||
        (permission === 'media' && details.mediaType === 'audio')
      );
    },
  );
}

export function buildContentSecurityPolicy(realtimeOrigin: string): string {
  const url = new URL(realtimeOrigin);
  if (
    url.protocol !== 'wss:' ||
    url.origin !== realtimeOrigin ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('Realtime origin must be an exact WSS origin');
  }

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' ${realtimeOrigin}`,
  ].join('; ');
}

export function installContentSecurityPolicy(
  session: SecuritySession,
  rendererEntry: string,
  policy: string,
): void {
  session.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      let responseHeaders = { ...details.responseHeaders };
      if (
        details.resourceType === 'mainFrame' &&
        isAllowedRendererUrl(details.url, rendererEntry)
      ) {
        responseHeaders = Object.fromEntries(
          Object.entries(responseHeaders).filter(
            ([name]) => name.toLowerCase() !== 'content-security-policy',
          ),
        );
        responseHeaders['Content-Security-Policy'] = [policy];
      }
      callback({ responseHeaders });
    },
  );
}
