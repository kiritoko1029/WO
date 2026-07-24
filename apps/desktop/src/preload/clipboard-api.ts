import type { Invoke } from './api.js';
import { DesktopIpcError, unwrapDesktopIpcEnvelope } from './ipc-envelope.js';

export interface DesktopClipboardBridge {
  writeText(value: string): Promise<void>;
}

function parseNull(input: unknown): null {
  if (input !== null) throw new TypeError('Expected null');
  return null;
}

export function createDesktopClipboardBridge(
  invoke: Invoke,
): Readonly<DesktopClipboardBridge> {
  return Object.freeze({
    writeText: async (value: string) => {
      let envelope: unknown;
      try {
        envelope = await invoke('desktop:clipboard:write-text', value);
      } catch {
        throw new DesktopIpcError('IPC_UNAVAILABLE');
      }
      unwrapDesktopIpcEnvelope(envelope, parseNull);
    },
  });
}
