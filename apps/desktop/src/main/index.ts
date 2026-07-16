import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';

import { createAuthSessionBroker } from './auth-session-broker.js';
import { createMainHttpClient } from './http-client.js';
import { registerDesktopIpc } from './ipc.js';
import { establishDesktopLifecycle } from './lifecycle.js';
import { createRealtimeTicketBroker } from './realtime-ticket-broker.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createSecureSessionStore } from './secure-session-store.js';
import {
  buildContentSecurityPolicy,
  createWindowOptions,
  installContentSecurityPolicy,
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

let mainWindow: BrowserWindow | null = null;
const ownsSingleInstance = establishDesktopLifecycle({
  app,
  developmentProfile: runtime.developmentProfile,
  getMainWindow: () => mainWindow,
});

app.enableSandbox();

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
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(runtime.rendererEntry);
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
  const realtime = createRealtimeTicketBroker({ http });
  registerDesktopIpc(ipcMain, {
    auth,
    realtime,
    rendererEntry: runtime.rendererEntry,
  });

  void app.whenReady().then(() => {
    mainWindow = createMainWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
