import {
  authLoginBodySchema,
  authRegisterBodySchema,
  opaqueTokenSchema,
} from '@wo/protocol';

import {
  createDesktopIpcFailure,
  createDesktopIpcSuccess,
  type DesktopIpcEnvelope,
  type DesktopIpcErrorCode,
} from '../preload/ipc-envelope.js';
import type { AuthSessionBroker } from './auth-session-broker.js';
import type { RealtimeTicketBroker } from './realtime-ticket-broker.js';
import { parseCaptureSourceToken } from './capture-policy.js';
import type { CaptureSourceService } from './capture-sources.js';
import type { ScreenPermissionService } from './permissions.js';
import { isAllowedRendererUrl } from './window-security.js';

export const DESKTOP_IPC_CHANNELS = Object.freeze([
  'desktop:auth:register',
  'desktop:auth:login',
  'desktop:auth:refresh',
  'desktop:auth:logout',
  'desktop:realtime:issue-ticket',
  'desktop:capture:list',
  'desktop:capture:select',
  'desktop:capture:permission',
  'desktop:capture:open-settings',
] as const);

type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[number];

export interface DesktopIpcMain {
  handle(
    channel: DesktopIpcChannel,
    handler: (event: unknown, ...arguments_: readonly unknown[]) => unknown,
  ): void;
}

export interface DesktopIpcDependencies {
  readonly auth: AuthSessionBroker;
  readonly realtime: RealtimeTicketBroker;
  readonly capture: CaptureSourceService;
  readonly permissions: ScreenPermissionService;
  readonly rendererEntry: string;
}

interface IpcEventShape {
  readonly senderFrame?: unknown;
  readonly sender?: { readonly id?: unknown; readonly mainFrame?: unknown };
}

function trustedWebContentsId(event: unknown, rendererEntry: string): number {
  assertTrustedSender(event, rendererEntry);
  const id = (event as IpcEventShape).sender?.id;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) {
    throw new DesktopIpcBoundaryError('IPC_FORBIDDEN');
  }
  return id as number;
}

class DesktopIpcBoundaryError extends Error {
  readonly code: DesktopIpcErrorCode;

  constructor(code: DesktopIpcErrorCode) {
    super(code);
    this.name = 'DesktopIpcBoundaryError';
    this.code = code;
  }
}

export function assertTrustedSender(
  event: unknown,
  rendererEntry: string,
): void {
  if (typeof event !== 'object' || event === null) {
    throw new DesktopIpcBoundaryError('IPC_FORBIDDEN');
  }
  const candidate = event as IpcEventShape;
  const frame = candidate.senderFrame;
  if (
    typeof frame !== 'object' ||
    frame === null ||
    candidate.sender?.mainFrame !== frame ||
    !('url' in frame) ||
    typeof frame.url !== 'string' ||
    !isAllowedRendererUrl(frame.url, rendererEntry)
  ) {
    throw new DesktopIpcBoundaryError('IPC_FORBIDDEN');
  }
}

function parseArguments<Result>(
  arguments_: readonly unknown[],
  expectedCount: number,
  parser: () => Result,
): Result {
  if (arguments_.length !== expectedCount) {
    throw new DesktopIpcBoundaryError('INVALID_ARGUMENTS');
  }
  try {
    return parser();
  } catch {
    throw new DesktopIpcBoundaryError('INVALID_ARGUMENTS');
  }
}

function registerHandler<Value>(
  ipcMain: DesktopIpcMain,
  channel: DesktopIpcChannel,
  operation: (event: unknown, arguments_: readonly unknown[]) => Promise<Value>,
): void {
  ipcMain.handle(
    channel,
    async (event, ...arguments_): Promise<DesktopIpcEnvelope<Value>> => {
      try {
        return createDesktopIpcSuccess(await operation(event, arguments_));
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );
}

export function registerDesktopIpc(
  ipcMain: DesktopIpcMain,
  dependencies: DesktopIpcDependencies,
): void {
  registerHandler(
    ipcMain,
    'desktop:auth:register',
    async (event, arguments_) => {
      assertTrustedSender(event, dependencies.rendererEntry);
      const input = parseArguments(arguments_, 1, () =>
        authRegisterBodySchema.parse(arguments_[0]),
      );
      return dependencies.auth.register(input);
    },
  );
  registerHandler(ipcMain, 'desktop:auth:login', async (event, arguments_) => {
    assertTrustedSender(event, dependencies.rendererEntry);
    const input = parseArguments(arguments_, 1, () =>
      authLoginBodySchema.parse(arguments_[0]),
    );
    return dependencies.auth.login(input);
  });
  registerHandler(
    ipcMain,
    'desktop:auth:refresh',
    async (event, arguments_) => {
      assertTrustedSender(event, dependencies.rendererEntry);
      parseArguments(arguments_, 0, () => undefined);
      return dependencies.auth.refresh();
    },
  );
  registerHandler(ipcMain, 'desktop:auth:logout', async (event, arguments_) => {
    assertTrustedSender(event, dependencies.rendererEntry);
    parseArguments(arguments_, 0, () => undefined);
    await dependencies.auth.logout();
    return null;
  });
  registerHandler(
    ipcMain,
    'desktop:realtime:issue-ticket',
    async (event, arguments_) => {
      assertTrustedSender(event, dependencies.rendererEntry);
      const accessToken = parseArguments(arguments_, 1, () =>
        opaqueTokenSchema.parse(arguments_[0]),
      );
      return dependencies.realtime.issueTicket(accessToken);
    },
  );
  registerHandler(
    ipcMain,
    'desktop:capture:list',
    async (event, arguments_) => {
      const webContentsId = trustedWebContentsId(
        event,
        dependencies.rendererEntry,
      );
      parseArguments(arguments_, 0, () => undefined);
      return dependencies.capture.list(webContentsId);
    },
  );
  registerHandler(
    ipcMain,
    'desktop:capture:select',
    async (event, arguments_) => {
      const webContentsId = trustedWebContentsId(
        event,
        dependencies.rendererEntry,
      );
      const token = parseArguments(arguments_, 1, () =>
        parseCaptureSourceToken(arguments_[0]),
      );
      dependencies.capture.select(webContentsId, token);
      return null;
    },
  );
  registerHandler(
    ipcMain,
    'desktop:capture:permission',
    async (event, arguments_) => {
      assertTrustedSender(event, dependencies.rendererEntry);
      parseArguments(arguments_, 0, () => undefined);
      return dependencies.permissions.status();
    },
  );
  registerHandler(
    ipcMain,
    'desktop:capture:open-settings',
    async (event, arguments_) => {
      assertTrustedSender(event, dependencies.rendererEntry);
      parseArguments(arguments_, 0, () => undefined);
      await dependencies.permissions.openSettings();
      return null;
    },
  );
}
