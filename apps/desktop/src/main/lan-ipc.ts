import {
  displayNameSchema,
  lanJoinIntentSchema,
  type LanJoinIntent,
} from '@wo/protocol';

import {
  createDesktopIpcFailure,
  createDesktopIpcSuccess,
  type DesktopIpcEnvelope,
} from '../preload/ipc-envelope.js';
import type { LanSocketEvent } from '../preload/lan-types.js';
import { assertTrustedSender } from './ipc.js';
import { parseJoinIntent } from './join-intent.js';
import type { LanSessionController } from './lan-session.js';
import type { LanSocketController } from './lan-socket.js';
import { isAllowedRendererUrl } from './window-security.js';

export const LAN_SOCKET_EVENT_CHANNEL = 'desktop:lan:socket:event';

export const LAN_IPC_CHANNELS = Object.freeze([
  'desktop:lan:host',
  'desktop:lan:join',
  'desktop:lan:parse-invite',
  'desktop:lan:issue-ticket',
  'desktop:lan:stop',
  'desktop:lan:socket:open',
  'desktop:lan:socket:send',
  'desktop:lan:socket:close',
] as const);

type LanIpcChannel = (typeof LAN_IPC_CHANNELS)[number];

export interface LanIpcMain {
  handle(
    channel: LanIpcChannel,
    handler: (event: unknown, ...arguments_: readonly unknown[]) => unknown,
  ): void;
}

interface Sender {
  readonly id: number;
  readonly mainFrame?: unknown;
  getURL(): string;
  isDestroyed(): boolean;
  once(type: 'destroyed', listener: () => void): void;
  send(channel: string, event: LanSocketEvent): void;
}

interface IpcEvent {
  readonly senderFrame?: unknown;
  readonly sender?: Sender;
}

export interface LanIpcDependencies {
  readonly sessions: LanSessionController;
  readonly sockets: LanSocketController;
  readonly rendererEntry: string;
}

class LanIpcError extends Error {
  readonly code = 'INVALID_ARGUMENTS';
}

function sender(event: unknown, rendererEntry: string): Sender {
  assertTrustedSender(event, rendererEntry);
  const candidate = (event as IpcEvent).sender;
  if (
    candidate === undefined ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.getURL !== 'function' ||
    typeof candidate.isDestroyed !== 'function' ||
    typeof candidate.once !== 'function' ||
    typeof candidate.send !== 'function'
  ) {
    throw new LanIpcError();
  }
  return candidate;
}

function argumentsOf<Value>(
  values: readonly unknown[],
  count: number,
  parse: () => Value,
): Value {
  if (values.length !== count) throw new LanIpcError();
  try {
    return parse();
  } catch {
    throw new LanIpcError();
  }
}

function register<Value>(
  ipcMain: LanIpcMain,
  channel: LanIpcChannel,
  operation: (event: unknown, values: readonly unknown[]) => Promise<Value>,
): void {
  ipcMain.handle(
    channel,
    async (event, ...values): Promise<DesktopIpcEnvelope<Value>> => {
      try {
        return createDesktopIpcSuccess(await operation(event, values));
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );
}

export function registerLanIpc(
  ipcMain: LanIpcMain,
  dependencies: LanIpcDependencies,
): void {
  const watchedOwners = new Set<number>();
  const watchOwner = (owner: Sender): void => {
    if (watchedOwners.has(owner.id)) return;
    watchedOwners.add(owner.id);
    owner.once('destroyed', () => {
      watchedOwners.delete(owner.id);
      dependencies.sockets.close(owner.id);
    });
  };

  register(ipcMain, 'desktop:lan:host', async (event, values) => {
    sender(event, dependencies.rendererEntry);
    const displayName = argumentsOf(values, 1, () =>
      displayNameSchema.parse(values[0]),
    );
    dependencies.sockets.stop();
    return dependencies.sessions.startHost(displayName);
  });
  register(ipcMain, 'desktop:lan:join', async (event, values) => {
    sender(event, dependencies.rendererEntry);
    const input = argumentsOf(values, 2, () => ({
      displayName: displayNameSchema.parse(values[0]),
      intent: lanJoinIntentSchema.parse(values[1]),
    }));
    dependencies.sockets.stop();
    return dependencies.sessions.startGuest(input.displayName, input.intent);
  });
  register(ipcMain, 'desktop:lan:parse-invite', async (event, values) => {
    sender(event, dependencies.rendererEntry);
    const value = argumentsOf(values, 1, () => {
      if (typeof values[0] !== 'string') throw new LanIpcError();
      return values[0];
    });
    const intent = parseJoinIntent(value);
    if (intent?.mode !== 'lan') throw new LanIpcError();
    return intent satisfies LanJoinIntent;
  });
  register(ipcMain, 'desktop:lan:issue-ticket', async (event, values) => {
    sender(event, dependencies.rendererEntry);
    argumentsOf(values, 0, () => undefined);
    return dependencies.sessions.issueTicket();
  });
  register(ipcMain, 'desktop:lan:stop', async (event, values) => {
    sender(event, dependencies.rendererEntry);
    argumentsOf(values, 0, () => undefined);
    dependencies.sockets.stop();
    await dependencies.sessions.stop();
    return null;
  });
  register(ipcMain, 'desktop:lan:socket:open', async (event, values) => {
    const owner = sender(event, dependencies.rendererEntry);
    const input = argumentsOf(values, 2, () => {
      if (
        typeof values[0] !== 'string' ||
        !Array.isArray(values[1]) ||
        !values[1].every((value) => typeof value === 'string')
      ) {
        throw new LanIpcError();
      }
      return {
        endpoint: values[0],
        protocols: values[1] as readonly string[],
      };
    });
    dependencies.sockets.open(
      owner.id,
      input.endpoint,
      input.protocols,
      (socketEvent) => {
        if (
          owner.isDestroyed() ||
          !isAllowedRendererUrl(owner.getURL(), dependencies.rendererEntry)
        ) {
          dependencies.sockets.close(owner.id);
          return;
        }
        owner.send(LAN_SOCKET_EVENT_CHANNEL, socketEvent);
      },
    );
    watchOwner(owner);
    return null;
  });
  register(ipcMain, 'desktop:lan:socket:send', async (event, values) => {
    const owner = sender(event, dependencies.rendererEntry);
    const data = argumentsOf(values, 1, () => {
      if (typeof values[0] !== 'string') throw new LanIpcError();
      return values[0];
    });
    dependencies.sockets.send(owner.id, data);
    return null;
  });
  register(ipcMain, 'desktop:lan:socket:close', async (event, values) => {
    const owner = sender(event, dependencies.rendererEntry);
    argumentsOf(values, 0, () => undefined);
    dependencies.sockets.close(owner.id);
    return null;
  });
}
