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

    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: {
          SystemRoot: 'C:\\Windows',
          SAFE_PARENT_VALUE: 'preserved',
        },
        execFile,
        currentProcessId: 900,
      }),
    ).resolves.toBe(4_321);

    expect(execFile).toHaveBeenCalledOnce();
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
      timeout: 2_500,
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
    expect(probeScript).toContain(
      '$ownProcessIds.Contains([uint32]$target.ProcessId)',
    );
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
      await expect(
        resolveWindowsWindowProcessId('101', {
          environment: { SystemRoot: 'C:\\Windows' },
          execFile,
        }),
      ).resolves.toBe(expected);
    },
  );

  test('fails closed before execution for invalid system or window identity', async () => {
    const execFile = vi.fn<CaptureAudioExecFile>();

    await expect(
      resolveWindowsWindowProcessId('0', {
        environment: { SystemRoot: 'C:\\Windows' },
        execFile,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: { SystemRoot: 'relative\\windows' },
        execFile,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveWindowsWindowProcessId('101', {
        environment: { SystemRoot: 'C:\\Windows' },
        execFile,
        currentProcessId: 4_294_967_296,
      }),
    ).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  test('maps a Windows window to Chromium application process-tree loopback', async () => {
    const resolveWindowsWindowProcessId = vi.fn(async () => 7_654);

    await expect(
      resolveCaptureAudioTarget({
        source: { id: 'window:101:0', name: 'Editor' },
        platform: 'win32',
        currentProcessId: 900,
        resolveWindowsWindowProcessId,
      }),
    ).resolves.toEqual({
      id: 'applicationLoopback:7654',
      name: 'Selected application audio',
    });
    expect(resolveWindowsWindowProcessId).toHaveBeenCalledWith('101', 900);
  });

  test.each([
    ['resolver failure', null, 900],
    ['WO itself', 900, 900],
    ['zero PID', 0, 900],
    ['oversized PID', 4_294_967_296, 900],
    ['oversized WO PID', 7_654, 4_294_967_296],
  ] as const)(
    'does not grant Windows application audio on %s',
    async (_label, resolvedProcessId, currentProcessId) => {
      await expect(
        resolveCaptureAudioTarget({
          source: { id: 'window:101:0', name: 'Editor' },
          platform: 'win32',
          currentProcessId,
          resolveWindowsWindowProcessId: async () => resolvedProcessId,
        }),
      ).resolves.toBeNull();
    },
  );

  test.each(['win32', 'darwin'] as const)(
    'maps a %s screen to system loopback with WO playback excluded',
    async (platform) => {
      await expect(
        resolveCaptureAudioTarget({
          source: { id: 'screen:202:0', name: 'Entire screen' },
          platform,
          currentProcessId: 900,
        }),
      ).resolves.toEqual({
        id: 'loopbackWithoutChrome',
        name: 'System audio without WO playback',
      });
    },
  );

  test('does not widen a macOS custom-picker window to system loopback', async () => {
    await expect(
      resolveCaptureAudioTarget({
        source: { id: 'window:101:0', name: 'Editor' },
        platform: 'darwin',
        currentProcessId: 900,
      }),
    ).resolves.toBeNull();
  });
});
