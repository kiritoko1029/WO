import {
  createJoinProtocolUrl,
  serverJoinIntentSchema,
  SOURCE_REPOSITORY_URL,
  type JoinIntent,
} from '@wo/protocol';
import {
  createDesktopIpcFailure,
  createDesktopIpcSuccess,
  type DesktopIpcEnvelope,
} from '../preload/ipc-envelope.js';
import type { BackendTargetSnapshot } from '../preload/types.js';
import type { BackendTargetStore } from './backend-target.js';
import { assertTrustedSender } from './ipc.js';
import type { PendingJoinIntentStore } from './join-intent.js';

export const SHELL_CONFIG_IPC_CHANNELS = Object.freeze([
  'desktop:shell:backend-target:get',
  'desktop:shell:backend-target:save',
  'desktop:shell:join-intent:consume',
  'desktop:shell:join-intent:switch-server',
  'desktop:shell:open-external',
] as const);
export const SHELL_JOIN_INTENT_NOTIFICATION_CHANNEL =
  'desktop:shell:join-intent:available';

type ShellConfigIpcChannel = (typeof SHELL_CONFIG_IPC_CHANNELS)[number];

export interface ShellConfigIpcMain {
  handle(
    channel: ShellConfigIpcChannel,
    handler: (event: unknown, ...arguments_: readonly unknown[]) => unknown,
  ): void;
}

export interface ShellConfigApp {
  relaunch(options?: { readonly args: string[] }): void;
  quit(): void;
}

export interface ShellConfigShell {
  openExternal(url: string): Promise<void>;
}

export interface ShellConfigIpcDependencies {
  readonly app: ShellConfigApp;
  readonly backendTarget: BackendTargetStore;
  readonly joinIntents: PendingJoinIntentStore;
  readonly relaunchArguments: readonly string[];
  readonly rendererEntry: string;
  readonly scheduleRestart?: (restart: () => void) => void;
  readonly shell?: ShellConfigShell;
}

function invalidArguments(): Error & { readonly code: 'INVALID_ARGUMENTS' } {
  return Object.assign(new Error('Invalid arguments'), {
    code: 'INVALID_ARGUMENTS' as const,
  });
}

/**
 * The renderer may only ask the OS to open the public source repository (or a
 * path inside it). Everything else — other hosts, schemes, credentials — is
 * rejected before reaching `shell.openExternal`.
 */
export function isAllowedExternalUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      (url.href === SOURCE_REPOSITORY_URL ||
        url.href.startsWith(`${SOURCE_REPOSITORY_URL}/`))
    );
  } catch {
    return false;
  }
}

export function registerShellConfigIpc(
  ipcMain: ShellConfigIpcMain,
  dependencies: ShellConfigIpcDependencies,
): void {
  const scheduleRestart =
    dependencies.scheduleRestart ?? ((restart) => setImmediate(restart));
  let restartScheduled = false;
  const restart = (arguments_?: readonly string[]): void => {
    if (restartScheduled) return;
    restartScheduled = true;
    scheduleRestart(() => {
      dependencies.app.relaunch(
        arguments_ === undefined ? undefined : { args: [...arguments_] },
      );
      dependencies.app.quit();
    });
  };

  ipcMain.handle(
    'desktop:shell:backend-target:get',
    async (
      event,
      ...arguments_
    ): Promise<DesktopIpcEnvelope<BackendTargetSnapshot>> => {
      try {
        assertTrustedSender(event, dependencies.rendererEntry);
        if (arguments_.length !== 0) throw invalidArguments();
        return createDesktopIpcSuccess(dependencies.backendTarget.current());
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );

  ipcMain.handle(
    'desktop:shell:backend-target:save',
    async (event, ...arguments_): Promise<DesktopIpcEnvelope<null>> => {
      try {
        assertTrustedSender(event, dependencies.rendererEntry);
        if (arguments_.length !== 1 || typeof arguments_[0] !== 'string') {
          throw invalidArguments();
        }
        dependencies.backendTarget.save(arguments_[0]);
        restart(dependencies.relaunchArguments);
        return createDesktopIpcSuccess(null);
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );

  ipcMain.handle(
    'desktop:shell:join-intent:consume',
    async (
      event,
      ...arguments_
    ): Promise<DesktopIpcEnvelope<JoinIntent | null>> => {
      try {
        assertTrustedSender(event, dependencies.rendererEntry);
        if (arguments_.length !== 0) throw invalidArguments();
        return createDesktopIpcSuccess(dependencies.joinIntents.consume());
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );

  ipcMain.handle(
    'desktop:shell:join-intent:switch-server',
    async (event, ...arguments_): Promise<DesktopIpcEnvelope<null>> => {
      try {
        assertTrustedSender(event, dependencies.rendererEntry);
        if (arguments_.length !== 1) throw invalidArguments();
        const intent = serverJoinIntentSchema.safeParse(arguments_[0]);
        if (!intent.success) throw invalidArguments();
        dependencies.backendTarget.save(intent.data.serverOrigin);
        restart([
          ...dependencies.relaunchArguments,
          createJoinProtocolUrl(intent.data),
        ]);
        return createDesktopIpcSuccess(null);
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );

  ipcMain.handle(
    'desktop:shell:open-external',
    async (event, ...arguments_): Promise<DesktopIpcEnvelope<null>> => {
      try {
        assertTrustedSender(event, dependencies.rendererEntry);
        if (
          arguments_.length !== 1 ||
          typeof arguments_[0] !== 'string' ||
          !isAllowedExternalUrl(arguments_[0])
        ) {
          throw invalidArguments();
        }
        const shell = dependencies.shell;
        if (shell !== undefined) await shell.openExternal(arguments_[0]);
        return createDesktopIpcSuccess(null);
      } catch (error) {
        return createDesktopIpcFailure(error);
      }
    },
  );
}
