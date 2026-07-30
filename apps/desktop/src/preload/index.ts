import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopApi } from './api.js';
import { createDesktopClipboardBridge } from './clipboard-api.js';
import { createDesktopLanBridge } from './lan-api.js';
import { createDesktopShellBridge } from './shell-config-api.js';

const invoke = (channel: string, ...arguments_: readonly unknown[]) =>
  ipcRenderer.invoke(channel, ...arguments_);
const subscribe = (channel: string, listener: () => void) => {
  const handler = () => listener();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const subscribeValue = (
  channel: string,
  listener: (value: unknown) => void,
) => {
  const handler = (_event: unknown, value: unknown) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('desktop', createDesktopApi(invoke, subscribe));
contextBridge.exposeInMainWorld(
  'woLan',
  createDesktopLanBridge(invoke, subscribeValue),
);
contextBridge.exposeInMainWorld(
  'woShell',
  createDesktopShellBridge(invoke, subscribe),
);
contextBridge.exposeInMainWorld(
  'woClipboard',
  createDesktopClipboardBridge(invoke),
);
