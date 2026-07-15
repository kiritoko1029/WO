import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  type Session,
} from 'electron';

import { CaptureSourceSelection } from './capture-policy.js';
import { registerAppReady, WindowOwner } from './lifecycle.js';
import { shouldTrustLabCertificate } from './security.js';

type LabRole = 'publisher' | 'receiver';

const directory = fileURLToPath(new URL('.', import.meta.url));
const labEndpoint = process.env.MEDIA_LAB_URL ?? 'wss://127.0.0.1:4443';
const selections = new Map<
  number,
  CaptureSourceSelection<Electron.DesktopCapturerSource>
>();
const windowOwner = new WindowOwner<BrowserWindow>();

app.enableSandbox();

function requestedRoles(): readonly LabRole[] {
  const roleArgument = process.argv.find((argument) =>
    argument.startsWith('--role='),
  );
  const role = roleArgument?.slice('--role='.length);
  if (role === 'publisher' || role === 'receiver') return [role];
  return ['publisher', 'receiver'];
}

function configureCertificateGate(session: Session): void {
  session.setCertificateVerifyProc((request, callback) => {
    if (request.verificationResult === 'OK') {
      callback(0);
      return;
    }
    callback(
      shouldTrustLabCertificate({
        allowSelfSigned: process.env.MEDIA_LAB_ALLOW_SELF_SIGNED === '1',
        endpoint: labEndpoint,
        hostname: request.hostname,
        verificationResult: request.verificationResult,
      })
        ? 0
        : -2,
    );
  });
}

function createLabWindow(role: LabRole): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: `Media Lab - ${role}`,
    backgroundColor: '#f4f5f3',
    webPreferences: {
      preload: join(directory, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: `media-lab-${role}`,
    },
  });
  const selection =
    new CaptureSourceSelection<Electron.DesktopCapturerSource>();
  selections.set(window.webContents.id, selection);
  configureCertificateGate(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.once('did-finish-load', () => {
    console.info(`Media lab ${role} renderer ready`);
  });
  window.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (
        !request.videoRequested ||
        !request.userGesture ||
        request.audioRequested
      ) {
        callback({});
        return;
      }
      try {
        callback({ video: selection.selectedForRequest() });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );
  window.webContents.once('destroyed', () => {
    selections.delete(window.webContents.id);
  });

  const query = { role, labUrl: labEndpoint };
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    url.search = new URLSearchParams(query).toString();
    void window.loadURL(url.href);
  } else {
    void window.loadFile(join(directory, '../renderer/index.html'), { query });
  }
  return window;
}

function openRequestedWindows(): void {
  for (const role of requestedRoles()) {
    windowOwner.add(createLabWindow(role));
  }
}

ipcMain.handle('media-lab:list-sources', async (event) => {
  const selection = selections.get(event.sender.id);
  if (!selection) throw new Error('Capture source context is unavailable');
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: false,
    thumbnailSize: { width: 320, height: 180 },
  });
  selection.replaceAvailable(sources);
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('media-lab:select-source', (event, id: unknown) => {
  if (typeof id !== 'string' || id.length > 256) {
    throw new Error('Invalid capture source ID');
  }
  const selection = selections.get(event.sender.id);
  if (!selection) throw new Error('Capture source context is unavailable');
  selection.select(id);
});

ipcMain.handle('media-lab:export-stats', async (_event, json: unknown) => {
  if (typeof json !== 'string' || json.length > 10_000_000) {
    throw new Error('Invalid stats export');
  }
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Invalid stats export');
  const result = await dialog.showSaveDialog({
    title: 'Export media lab stats',
    defaultPath: `media-lab-${new Date().toISOString().replaceAll(':', '-')}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await writeFile(result.filePath, json, 'utf8');
  return result.filePath;
});

registerAppReady(app, openRequestedWindows);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openRequestedWindows();
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
