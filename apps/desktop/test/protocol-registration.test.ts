import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { registerDesktopProtocol } from '../src/main/protocol-registration.js';

describe('desktop protocol registration', () => {
  it('registers packaged applications directly', () => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };

    expect(
      registerDesktopProtocol(app, {
        defaultApp: false,
        executablePath: '/Applications/WO.app/Contents/MacOS/WO',
        argumentsList: ['WO'],
      }),
    ).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('wo');
  });

  it('registers the Electron development entry explicitly', () => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };

    expect(
      registerDesktopProtocol(app, {
        defaultApp: true,
        executablePath: '/usr/local/bin/electron',
        argumentsList: ['electron', './apps/desktop'],
      }),
    ).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      'wo',
      '/usr/local/bin/electron',
      [resolve('./apps/desktop')],
    );
  });

  it('prefers the original Windows portable executable over the temporary runtime', () => {
    const app = { setAsDefaultProtocolClient: vi.fn(() => true) };

    expect(
      registerDesktopProtocol(app, {
        defaultApp: false,
        executablePath: 'C:\\Temp\\wo-portable\\WO.exe',
        portableExecutablePath: 'D:\\Tools\\WO-portable.exe',
        argumentsList: ['C:\\Temp\\wo-portable\\WO.exe'],
      }),
    ).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      'wo',
      'D:\\Tools\\WO-portable.exe',
      [],
    );
  });

  it('reports missing development entries and platform failures', () => {
    const missing = { setAsDefaultProtocolClient: vi.fn(() => true) };
    expect(
      registerDesktopProtocol(missing, {
        defaultApp: true,
        executablePath: '/usr/local/bin/electron',
        argumentsList: ['electron'],
      }),
    ).toBe(false);
    expect(missing.setAsDefaultProtocolClient).not.toHaveBeenCalled();

    expect(
      registerDesktopProtocol(
        {
          setAsDefaultProtocolClient: vi.fn(() => {
            throw new Error('platform rejected registration');
          }),
        },
        {
          defaultApp: false,
          executablePath: 'WO',
          argumentsList: ['WO'],
        },
      ),
    ).toBe(false);
  });
});
