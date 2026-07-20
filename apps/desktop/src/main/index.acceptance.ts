import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  net,
  safeStorage,
  shell,
  systemPreferences,
} from 'electron';
import type { JoinIntent } from '@wo/protocol';

import { acceptsPinnedAcceptanceCertificate } from './acceptance-certificate.js';
import { createAuthSessionBroker } from './auth-session-broker.js';
import { createBackendTargetStore } from './backend-target.js';
import { createCaptureSourceBroker } from './capture-policy.js';
import {
  createCaptureSourceService,
  installDisplayMediaHandler,
} from './capture-sources.js';
import { createMainHttpClient } from './http-client.js';
import { registerDesktopIpc } from './ipc.js';
import {
  createPendingJoinIntentStore,
  withoutJoinIntentArguments,
} from './join-intent.js';
import { establishDesktopLifecycle } from './lifecycle.js';
import {
  resolvePackageSmokeRequest,
  waitForPackageSmokeRendererReady,
  writePackageSmokeReady,
} from './package-smoke.js';
import { createScreenPermissionService } from './permissions.js';
import { createRealtimeTicketBroker } from './realtime-ticket-broker.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createSecureSessionStore } from './secure-session-store.js';
import {
  registerShellConfigIpc,
  SHELL_JOIN_INTENT_NOTIFICATION_CHANNEL,
} from './shell-config-ipc.js';
import {
  buildContentSecurityPolicy,
  createWindowOptions,
  installContentSecurityPolicy,
  installMediaPermissionPolicy,
  installWindowSecurity,
} from './window-security.js';

declare const __WO_ACCEPTANCE_CA_SPKI__: string;
declare const __WO_ACCEPTANCE_CA_CERTIFICATE__: string;

const applicationId = 'cn.wo.desktop.acceptance';
const audioFile = process.env.WO_ACCEPTANCE_AUDIO_FILE;
const userDataDirectory = process.env.WO_ACCEPTANCE_USER_DATA_DIR;

if (
  audioFile === undefined ||
  !isAbsolute(audioFile) ||
  !audioFile.toLowerCase().endsWith('.wav') ||
  !statSync(audioFile).isFile()
) {
  throw new Error('WO_ACCEPTANCE_AUDIO_FILE must name an existing WAV file');
}
if (userDataDirectory === undefined || !isAbsolute(userDataDirectory)) {
  throw new Error('WO_ACCEPTANCE_USER_DATA_DIR must be absolute');
}

mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 });
const sessionDataDirectory = join(userDataDirectory, 'session-data');
mkdirSync(sessionDataDirectory, { recursive: true, mode: 0o700 });
app.setPath('userData', userDataDirectory);
app.setPath('sessionData', sessionDataDirectory);
app.setAppUserModelId(applicationId);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const audioFixture = readFileSync(audioFile);

app.on(
  'certificate-error',
  (event, _webContents, url, error, certificate, callback) => {
    const accepted = acceptsPinnedAcceptanceCertificate({
      url,
      error,
      certificate,
      pinnedRootSpki: __WO_ACCEPTANCE_CA_SPKI__,
      trustedRoot: __WO_ACCEPTANCE_CA_CERTIFICATE__,
    });
    if (accepted) {
      event.preventDefault();
    } else {
      let chainDepth = 0;
      let current: Electron.Certificate | undefined = certificate;
      const seen = new Set<string>();
      while (current !== undefined && !seen.has(current.data)) {
        seen.add(current.data);
        chainDepth += 1;
        current = current.issuerCert;
      }
      let endpoint = 'invalid';
      try {
        const parsed = new URL(url);
        endpoint = `${parsed.protocol}//${parsed.host}`;
      } catch {
        // Keep the non-sensitive invalid sentinel.
      }
      process.stderr.write(
        `WO_ACCEPTANCE_CERT_REJECTED endpoint=${endpoint} error=${error} chain=${chainDepth}\n`,
      );
    }
    callback(accepted);
  },
);

const diagnosticSnapshots = new Map<number, unknown>();
const forbiddenDiagnosticKey =
  /address|candidate|credential|email|endpoint|ip|password|sdp|token|url/iu;

function sanitizedDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new TypeError('Acceptance diagnostic is too deep');
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 64 || !/^[a-z0-9:._-]*$/iu.test(value)) {
      throw new TypeError('Acceptance diagnostic string is invalid');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 32)
      throw new TypeError('Acceptance diagnostic is large');
    return value.map((item) => sanitizedDiagnostic(item, depth + 1));
  }
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Acceptance diagnostic value is invalid');
  }
  const entries = Object.entries(value);
  if (entries.length > 64)
    throw new TypeError('Acceptance diagnostic is large');
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9]*$/iu.test(key) || forbiddenDiagnosticKey.test(key)) {
      throw new TypeError('Acceptance diagnostic key is invalid');
    }
    output[key] = sanitizedDiagnostic(item, depth + 1);
  }
  return output;
}

ipcMain.on('acceptance:diagnostics:report', (event, value: unknown) => {
  try {
    const snapshot = sanitizedDiagnostic(value);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 64 * 1024) {
      throw new RangeError('Acceptance diagnostic exceeds its limit');
    }
    diagnosticSnapshots.set(event.sender.id, snapshot);
  } catch {
    diagnosticSnapshots.delete(event.sender.id);
  }
});
ipcMain.handle('acceptance:diagnostics:snapshot', (event) => {
  return diagnosticSnapshots.get(event.sender.id) ?? null;
});
app.on('web-contents-created', (_event, contents) => {
  contents.once('destroyed', () => diagnosticSnapshots.delete(contents.id));
});

const directory = fileURLToPath(new URL('.', import.meta.url));
const packagedRendererEntry = pathToFileURL(
  join(directory, '../renderer/index.html'),
).href;
const backendTarget = createBackendTargetStore({
  userDataPath: app.getPath('userData'),
  environment: process.env,
});
const runtime = loadRuntimeConfig({
  apiOrigin: backendTarget.current().origin,
  isPackaged: app.isPackaged,
  environment: process.env,
  packagedRendererEntry,
});
ipcMain.handle('acceptance:audio:wav', (event) => {
  if (event.sender.getURL() !== runtime.rendererEntry) {
    throw new Error('Acceptance audio fixture request is untrusted');
  }
  return audioFixture;
});
const packageSmokeRequest = resolvePackageSmokeRequest({
  argumentsList: process.argv,
  environment: process.env,
  temporaryRoot: tmpdir(),
});

let mainWindow: BrowserWindow | null = null;
const joinIntents = createPendingJoinIntentStore();
const receiveJoinIntent = (intent: JoinIntent): void => {
  joinIntents.push(intent);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(SHELL_JOIN_INTENT_NOTIFICATION_CHANNEL);
  }
};
const ownsSingleInstance = establishDesktopLifecycle({
  app,
  developmentProfile: runtime.developmentProfile,
  getMainWindow: () => mainWindow,
  argumentsList: process.argv,
  onJoinIntent: receiveJoinIntent,
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
  const http = createMainHttpClient({
    apiOrigin: runtime.apiOrigin,
    fetch: net.fetch.bind(net),
  });
  const auth = createAuthSessionBroker({ http, sessionStore });
  const realtime = createRealtimeTicketBroker({
    http,
    realtimeOrigin: runtime.realtimeOrigin,
  });
  registerDesktopIpc(ipcMain, {
    auth,
    realtime,
    capture,
    clipboard,
    permissions,
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
