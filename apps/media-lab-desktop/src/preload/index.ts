import { contextBridge, ipcRenderer } from 'electron';

import { createMediaLabApi } from './api.js';

contextBridge.exposeInMainWorld(
  'mediaLab',
  createMediaLabApi((channel, ...arguments_) =>
    ipcRenderer.invoke(channel, ...arguments_),
  ),
);
