import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  net,
  powerMonitor,
  safeStorage,
  shell,
  systemPreferences,
} from 'electron';
import type { JoinIntent } from '@wo/protocol';

import { createAuthSessionBroker } from './auth-session-broker.js';
import { createBackendTargetStore } from './backend-target.js';
import { createCaptureSourceBroker } from './capture-policy.js';
import {
  createCaptureSourceService,
  installDisplayMediaHandler,
} from './capture-sources.js';
import { installExtraCaFromEnvironment } from './extra-ca.js';
import { createMainHttpClient } from './http-client.js';
import { registerDesktopIpc } from './ipc.js';
import {
  createPendingJoinIntentStore,
  withoutJoinIntentArguments,
} from './join-intent.js';
import { registerLanIpc } from './lan-ipc.js';
import { createLanSessionController } from './lan-session.js';
import { createLanSocketController } from './lan-socket.js';
import { establishDesktopLifecycle } from './lifecycle.js';
import {
  resolvePackageSmokeRequest,
  waitForPackageSmokeRendererReady,
  writePackageSmokeReady,
} from './package-smoke.js';
import { registerDesktopProtocol } from './protocol-registration.js';
import { createRealtimeTicketBroker } from './realtime-ticket-broker.js';
import {
  loadRuntimeConfig,
  resolveDevelopmentProfile,
} from './runtime-config.js';
import { createScreenPermissionService } from './permissions.js';
import { createSecureSessionStore } from './secure-session-store.js';
import {
  registerShellConfigIpc,
  SHELL_JOIN_INTENT_NOTIFICATION_CHANNEL,
} from './shell-config-ipc.js';
import {
  buildContentSecurityPolicy,
  buildDevelopmentContentSecurityPolicy,
  createWindowOptions,
  installContentSecurityPolicy,
  installMediaPermissionPolicy,
  installWindowSecurity,
} from './window-security.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const packagedRendererEntry = pathToFileURL(
  join(directory, '../renderer/index.html'),
).href;

// Dev-only: allow CDP clients (chrome-devtools MCP, chrome-remote-interface)
// to connect when REMOTE_DEBUGGING_PORT is set. Production builds ignore this
// because electron-vite only forwards the port flag in dev mode.
if (
  !app.isPackaged &&
  process.env.REMOTE_DEBUGGING_PORT !== undefined &&
  process.env.REMOTE_ALLOW_ORIGINS === undefined
) {
  app.commandLine.appendSwitch('remote-allow-origins', '*');
}
const runtimeInput = {
  isPackaged: app.isPackaged,
  environment: process.env,
  packagedRendererEntry,
} as const;
const packageSmokeRequest = resolvePackageSmokeRequest({
  argumentsList: process.argv,
  environment: process.env,
  temporaryRoot: tmpdir(),
});
if (
  !registerDesktopProtocol(app, {
    defaultApp: process.defaultApp === true,
    executablePath: process.execPath,
    argumentsList: process.argv,
    portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE,
  })
) {
  process.stderr.write('DESKTOP_PROTOCOL_REGISTRATION_FAILED\n');
}

let mainWindow: BrowserWindow | null = null;
let stopLanSession = (): Promise<void> => Promise.resolve();
const joinIntents = createPendingJoinIntentStore();
const receiveJoinIntent = (intent: JoinIntent): void => {
  joinIntents.push(intent);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SHELL_JOIN_INTENT_NOTIFICATION_CHANNEL);
  }
};
const ownsSingleInstance = establishDesktopLifecycle({
  app,
  developmentProfile: resolveDevelopmentProfile(runtimeInput),
  getMainWindow: () => mainWindow,
  argumentsList: process.argv,
  onJoinIntent: receiveJoinIntent,
});
const backendTarget = createBackendTargetStore({
  userDataPath: app.getPath('userData'),
  environment: process.env,
});
const runtime = loadRuntimeConfig({
  ...runtimeInput,
  apiOrigin: backendTarget.current().origin,
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
  // Dev mode runs against the Vite dev server, which injects an inline HMR
  // client and relies on eval for dependency optimization. Production CSP
  // (`script-src 'self'`) would block both, so we relax it only when the
  // app is unpackaged. See window-security.buildDevelopmentContentSecurityPolicy.
  const csp = app.isPackaged
    ? buildContentSecurityPolicy(runtime.realtimeOrigin)
    : buildDevelopmentContentSecurityPolicy(
        new URL(runtime.rendererEntry).origin,
        runtime.realtimeOrigin,
      );
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
  // A blank window with no diagnostic is the worst-case UX for a renderer
  // crash. Log the reason so it shows up in the terminal/log file, and try
  // to reload once in dev mode so the developer is not stuck on white screen.
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      '[main] Renderer process gone:',
      `reason=${details.reason}`,
      `exitCode=${details.exitCode}`,
    );
    if (!app.isPackaged && !window.isDestroyed()) {
      window
        .loadURL(runtime.rendererEntry)
        .catch((error: unknown) =>
          console.error('[main] Renderer reload failed:', error),
        );
    }
  });
  window.webContents.on('unresponsive', () => {
    console.error('[main] Renderer became unresponsive');
  });
  if (packageSmokeRequest === null) {
    window.once('ready-to-show', () => window.show());
  }
  window.once('closed', () => {
    if (mainWindow === window) mainWindow = null;
    void stopLanSession();
  });
  return window;
}

if (ownsSingleInstance) {
  const sessionStore = createSecureSessionStore({
    userDataPath: app.getPath('userData'),
    apiOrigin: runtime.apiOrigin,
    encryption: safeStorage,
  });
  // Use Chromium-backed net.fetch so system HTTP proxies (Clash/V2Ray) work.
  // Node/globalThis.fetch often fails with ECONNRESET through local proxies.
  const http = createMainHttpClient({
    apiOrigin: runtime.apiOrigin,
    fetch: net.fetch.bind(net),
  });
  const auth = createAuthSessionBroker({ http, sessionStore });
  const realtime = createRealtimeTicketBroker({
    http,
    realtimeOrigin: runtime.realtimeOrigin,
  });
  const lanSessions = createLanSessionController();
  const lanSockets = createLanSocketController({ sessions: lanSessions });
  stopLanSession = async () => {
    lanSockets.stop();
    await lanSessions.stop();
  };
  registerDesktopIpc(ipcMain, {
    auth,
    realtime,
    capture,
    clipboard,
    permissions,
    rendererEntry: runtime.rendererEntry,
  });
  registerLanIpc(ipcMain, {
    sessions: lanSessions,
    sockets: lanSockets,
    rendererEntry: runtime.rendererEntry,
  });
  registerShellConfigIpc(ipcMain, {
    app,
    backendTarget,
    joinIntents,
    relaunchArguments: withoutJoinIntentArguments(process.argv.slice(1)),
    rendererEntry: runtime.rendererEntry,
  });

  const appReady = app.whenReady();
  void appReady
    .then(async () => {
      installExtraCaFromEnvironment(process.env);
      if (packageSmokeRequest === null) {
        powerMonitor.on('suspend', () => {
          void stopLanSession();
        });
      }
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
    app.on('before-quit', () => {
      void stopLanSession();
    });
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
