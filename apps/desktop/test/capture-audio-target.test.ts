import { describe, expect, test, vi } from 'vitest';

import {
  parseWindowsCaptureWindowHandle,
  resolveCaptureAudioTarget,
  resolveWindowsWindowProcessId,
  type CaptureAudioExecFile,
} from '../src/main/capture-audio-target.js';

describe('desktop capture audio targets', () => {
  test.each([
    ['window:101:0', '101'],
    ['window:-9223372036854775808:0', '-9223372036854775808'],
    ['window:9223372036854775807:-1', '9223372036854775807'],
  ])('parses the strict Windows window handle in %s', (sourceId, expected) => {
    expect(parseWindowsCaptureWindowHandle(sourceId)).toBe(expected);
  });

  test.each([
    'screen:101:0',
    'window:0:0',
    'window:-0:0',
    'window:+1:0',
    'window:01:0',
    'window:1:+0',
    'window:1:00',
    'window:9223372036854775808:0',
    'window:-9223372036854775809:0',
    'window:1:0:s',
    'window:1',
    'window:not-a-handle:0',
  ])('rejects malformed or unusable Windows source ID %s', (sourceId) => {
    expect(parseWindowsCaptureWindowHandle(sourceId)).toBeNull();
  });

  test('resolves HWND identity through a fixed encoded PowerShell probe', async () => {
    const execFile = vi.fn<CaptureAudioExecFile>(async () => ({
      stdout: '{"pid":4321}\r\n',
      stderr: '',
    }));
    const onFailure = vi.fn();

    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: {
          SystemRoot: 'C:\\Windows',
          SAFE_PARENT_VALUE: 'preserved',
        },
        execFile,
        currentProcessId: 900,
        onFailure,
      }),
    ).resolves.toBe(4_321);

    expect(execFile).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    const [executable, arguments_, options] = execFile.mock.calls[0]!;
    expect(executable).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(arguments_).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      expect.stringMatching(/^[A-Za-z0-9+/]+=*$/u),
    ]);
    expect(arguments_).not.toContain('101');
    expect(options).toMatchObject({
      encoding: 'utf8',
      maxBuffer: 4_096,
      timeout: 10_000,
      windowsHide: true,
      env: {
        SAFE_PARENT_VALUE: 'preserved',
        WO_CAPTURE_AUDIO_WINDOW_HANDLE: '101',
        WO_CAPTURE_AUDIO_CURRENT_PROCESS_ID: '900',
      },
    });
    const encodedCommand = arguments_[6]!;
    const probeScript = Buffer.from(encodedCommand, 'base64').toString(
      'utf16le',
    );
    expect(probeScript).toContain(
      "GetEnvironmentVariable('WO_CAPTURE_AUDIO_CURRENT_PROCESS_ID')",
    );
    expect(probeScript).toContain('CreateToolhelp32Snapshot');
    expect(probeScript).toContain('QueryFullProcessImageName');
    expect(probeScript).toContain('Windows.UI.Core.CoreWindow');
    expect(probeScript).toContain('ownProcessIds.Contains(rootProcessId)');
    expect(probeScript).not.toContain('Get-CimInstance');
  });

  test.each([
    [{ stdout: '', stderr: '' }, null],
    [{ stdout: '{"pid":0}', stderr: '' }, null],
    [{ stdout: '{"pid":4294967296}', stderr: '' }, null],
    [{ stdout: '{"pid":1,"extra":true}', stderr: '' }, null],
    [{ stdout: '{"pid":"123"}', stderr: '' }, null],
    [{ stdout: 'warning\n{"pid":123}', stderr: '' }, null],
    [{ stdout: '{"pid":123}', stderr: 'warning' }, null],
  ] as const)(
    'fails closed on malformed PowerShell output %#',
    async (output, expected) => {
      const execFile = vi.fn<CaptureAudioExecFile>(async () => output);
      const onFailure = vi.fn();
      await expect(
        resolveWindowsWindowProcessId('101', {
          environment: { SystemRoot: 'C:\\Windows' },
          execFile,
          onFailure,
        }),
      ).resolves.toBe(expected);
      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith('PROBE_OUTPUT_INVALID');
    },
  );

  test('fails closed before execution for invalid system or window identity', async () => {
    const execFile = vi.fn<CaptureAudioExecFile>();
    const onFailure = vi.fn();

    await expect(
      resolveWindowsWindowProcessId('0', {
        environment: { SystemRoot: 'C:\\Windows' },
        execFile,
        onFailure,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: { SystemRoot: 'relative\\windows' },
        execFile,
        onFailure,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: { SystemRoot: 'C:\\Windows' },
        execFile,
        currentProcessId: 4_294_967_296,
        onFailure,
      }),
    ).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalled();
    expect(onFailure.mock.calls).toEqual([
      ['WINDOW_HANDLE_INVALID'],
      ['SYSTEM_ROOT_INVALID'],
      ['CURRENT_PROCESS_INVALID'],
    ]);
  });

  test('logs a bounded failure code when the Windows probe is terminated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFailure = vi.fn();
    const execFile = vi.fn<CaptureAudioExecFile>(async () => {
      throw Object.assign(new Error('sensitive child process details'), {
        killed: true,
      });
    });

    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: { SystemRoot: 'C:\\Windows' },
        execFile,
        onFailure,
      }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[capture-audio-target] Windows process probe failed: TERMINATED',
    );
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith('PROBE_TERMINATED');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sensitive');
    expect(onFailure.mock.calls.flat().join(' ')).not.toContain('sensitive');
    warn.mockRestore();
  });

  test.skipIf(process.platform !== 'win32')(
    'compiles the native Windows probe before rejecting an invalid HWND',
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onFailure = vi.fn();

      await expect(
        resolveWindowsWindowProcessId('1', { onFailure }),
      ).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[capture-audio-target] Windows process probe failed: EXIT_11',
      );
      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith('PROBE_EXIT_11');
      warn.mockRestore();
    },
  );

  test('maps a Windows window to Chromium application process-tree loopback', async () => {
    const resolveWindowsWindowProcessId = vi.fn(async () => 7_654);
    const onFailure = vi.fn();

    await expect(
      resolveCaptureAudioTarget({
        source: { id: 'window:101:0', name: 'Editor' },
        platform: 'win32',
        currentProcessId: 900,
        resolveWindowsWindowProcessId,
        onFailure,
      }),
    ).resolves.toEqual({
      id: 'applicationLoopback:7654',
      name: 'Selected application audio',
    });
    expect(resolveWindowsWindowProcessId).toHaveBeenCalledWith(
      '101',
      900,
      expect.any(Function),
    );
    expect(onFailure).not.toHaveBeenCalled();
  });

  test.each([
    ['resolver failure', null, 900, 'PROCESS_UNRESOLVED'],
    ['WO itself', 900, 900, 'TARGET_IS_WO'],
    ['zero PID', 0, 900, 'PROCESS_ID_INVALID'],
    ['oversized PID', 4_294_967_296, 900, 'PROCESS_ID_INVALID'],
    ['oversized WO PID', 7_654, 4_294_967_296, 'CURRENT_PROCESS_INVALID'],
  ] as const)(
    'does not grant Windows application audio on %s',
    async (_label, resolvedProcessId, currentProcessId, expectedCode) => {
      const onFailure = vi.fn();
      await expect(
        resolveCaptureAudioTarget({
          source: { id: 'window:101:0', name: 'Editor' },
          platform: 'win32',
          currentProcessId,
          resolveWindowsWindowProcessId: async () => resolvedProcessId,
          onFailure,
        }),
      ).resolves.toBeNull();
      expect(onFailure).toHaveBeenCalledOnce();
      expect(onFailure).toHaveBeenCalledWith(expectedCode);
    },
  );

  test.each(['win32', 'darwin'] as const)(
    'maps a %s screen to system loopback with WO playback excluded',
    async (platform) => {
      const onFailure = vi.fn();
      await expect(
        resolveCaptureAudioTarget({
          source: { id: 'screen:202:0', name: 'Entire screen' },
          platform,
          currentProcessId: 900,
          onFailure,
        }),
      ).resolves.toEqual({
        id: 'loopbackWithoutChrome',
        name: 'System audio without WO playback',
      });
      expect(onFailure).not.toHaveBeenCalled();
    },
  );

  test('does not widen a macOS custom-picker window to system loopback', async () => {
    const onFailure = vi.fn();
    await expect(
      resolveCaptureAudioTarget({
        source: { id: 'window:101:0', name: 'Editor' },
        platform: 'darwin',
        currentProcessId: 900,
        onFailure,
      }),
    ).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith('PLATFORM_UNSUPPORTED');
  });

  test('reports malformed source identity exactly once', async () => {
    const onFailure = vi.fn();

    await expect(
      resolveCaptureAudioTarget({
        source: { id: 'window:not-a-handle:0', name: 'Editor' },
        platform: 'win32',
        currentProcessId: 900,
        onFailure,
      }),
    ).resolves.toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith('SOURCE_ID_INVALID');
  });
});
