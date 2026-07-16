import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  safeStorage,
  shell,
  systemPreferences,
} from 'electron';

import { createAuthSessionBroker } from './auth-session-broker.js';
import { createCaptureSourceBroker } from './capture-policy.js';
import {
  createCaptureSourceService,
  installDisplayMediaHandler,
} from './capture-sources.js';
import { createMainHttpClient } from './http-client.js';
import { registerDesktopIpc } from './ipc.js';
import { establishDesktopLifecycle } from './lifecycle.js';
import {
  resolvePackageSmokeRequest,
  waitForPackageSmokeRendererReady,
  writePackageSmokeReady,
} from './package-smoke.js';
import { createRealtimeTicketBroker } from './realtime-ticket-broker.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createScreenPermissionService } from './permissions.js';
import { createSecureSessionStore } from './secure-session-store.js';
import {
  buildContentSecurityPolicy,
  createWindowOptions,
  installContentSecurityPolicy,
  installMediaPermissionPolicy,
  installWindowSecurity,
} from './window-security.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const packagedRendererEntry = pathToFileURL(
  join(directory, '../renderer/index.html'),
).href;
const runtime = loadRuntimeConfig({
  isPackaged: app.isPackaged,
  environment: process.env,
  packagedRendererEntry,
});
const packageSmokeRequest = resolvePackageSmokeRequest({
  argumentsList: process.argv,
  environment: process.env,
  temporaryRoot: tmpdir(),
});

let mainWindow: BrowserWindow | null = null;
const ownsSingleInstance = establishDesktopLifecycle({
  app,
  developmentProfile: runtime.developmentProfile,
  getMainWindow: () => mainWindow,
});

app.enableSandbox();

const captureBroker =
  createCaptureSourceBroker<Electron.DesktopCapturerSource>();
const capture = createCaptureSourceService({
  broker: captureBroker,
  desktopCapturer: {
    getSources: (options) =>
      desktopCapturer.getSources({
        ...options,
        types: [...options.types],
      }),
  },
});
const permissions = createScreenPermissionService({
  platform: process.platform,
  systemPreferences,
  shell,
});

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(
    createWindowOptions(join(directory, '../preload/index.js')),
  );
  const csp = buildContentSecurityPolicy(runtime.realtimeOrigin);
  installContentSecurityPolicy(
    window.webContents.session,
    runtime.rendererEntry,
    csp,
  );
  installWindowSecurity(window.webContents, runtime.rendererEntry);
  installMediaPermissionPolicy(
    window.webContents.session,
    runtime.rendererEntry,
  );
  installDisplayMediaHandler({
    session: window.webContents.session,
    webContents: window.webContents,
    rendererEntry: runtime.rendererEntry,
    broker: captureBroker,
  });
  const clearCaptureSources = (): void => capture.clear(window.webContents.id);
  window.webContents.on('did-start-navigation', clearCaptureSources);
  window.webContents.once('destroyed', clearCaptureSources);
  if (packageSmokeRequest === null) {
    window.once('ready-to-show', () => window.show());
  }
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

if (ownsSingleInstance) {
  const sessionStore = createSecureSessionStore({
    userDataPath: app.getPath('userData'),
    apiOrigin: runtime.apiOrigin,
    encryption: safeStorage,
  });
  const http = createMainHttpClient({ apiOrigin: runtime.apiOrigin });
  const auth = createAuthSessionBroker({ http, sessionStore });
  const realtime = createRealtimeTicketBroker({
    http,
    realtimeOrigin: runtime.realtimeOrigin,
  });
  registerDesktopIpc(ipcMain, {
    auth,
    realtime,
    capture,
    permissions,
    rendererEntry: runtime.rendererEntry,
  });

  const appReady = app.whenReady();
  void appReady
    .then(async () => {
      mainWindow = createMainWindow();
      await mainWindow.loadURL(runtime.rendererEntry);
      if (packageSmokeRequest !== null) {
        await waitForPackageSmokeRendererReady(mainWindow.webContents);
        await writePackageSmokeReady(packageSmokeRequest);
        app.quit();
      }
    })
    .catch(() => {
      process.stderr.write(
        packageSmokeRequest === null
          ? 'DESKTOP_STARTUP_FAILED\n'
          : 'DESKTOP_PACKAGE_SMOKE_FAILED\n',
      );
      app.exit(1);
    });

  if (packageSmokeRequest === null) {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
        void mainWindow.loadURL(runtime.rendererEntry);
      }
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
  }
}
