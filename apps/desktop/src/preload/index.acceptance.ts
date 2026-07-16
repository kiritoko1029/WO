import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopApi } from './api.js';

const iceTransportPolicy =
  process.env.WO_ACCEPTANCE_ICE_POLICY === 'relay' ? 'relay' : 'all';

contextBridge.exposeInMainWorld(
  'desktop',
  createDesktopApi((channel, ...arguments_) =>
    ipcRenderer.invoke(channel, ...arguments_),
  ),
);
contextBridge.exposeInMainWorld(
  'woAcceptance',
  Object.freeze({
    iceTransportPolicy,
    audioWav: async () => {
      const value: unknown = await ipcRenderer.invoke('acceptance:audio:wav');
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Acceptance audio fixture is invalid');
      }
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
    },
    report: (snapshot: unknown) =>
      ipcRenderer.send('acceptance:diagnostics:report', snapshot),
    snapshot: () => ipcRenderer.invoke('acceptance:diagnostics:snapshot'),
  }),
);
