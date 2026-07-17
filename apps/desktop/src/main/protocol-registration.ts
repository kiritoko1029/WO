import { resolve } from 'node:path';

export interface ProtocolRegistrationApp {
  setAsDefaultProtocolClient(
    protocol: string,
    path?: string,
    arguments_?: string[],
  ): boolean;
}

export function registerDesktopProtocol(
  app: ProtocolRegistrationApp,
  options: {
    readonly defaultApp: boolean;
    readonly executablePath: string;
    readonly argumentsList: readonly string[];
    readonly portableExecutablePath?: string;
  },
): boolean {
  try {
    if (options.portableExecutablePath?.trim()) {
      return app.setAsDefaultProtocolClient(
        'wo',
        options.portableExecutablePath,
        [],
      );
    }
    if (!options.defaultApp) {
      return app.setAsDefaultProtocolClient('wo');
    }
    const entry = options.argumentsList[1];
    if (entry === undefined) return false;
    return app.setAsDefaultProtocolClient('wo', options.executablePath, [
      resolve(entry),
    ]);
  } catch {
    return false;
  }
}
