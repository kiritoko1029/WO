import { execFile as nodeExecFile } from 'node:child_process';
import { win32 } from 'node:path';

const SIGNED_INT64_MIN = -(2n ** 63n);
const SIGNED_INT64_MAX = 2n ** 63n - 1n;
const WINDOWS_PROCESS_ID_MAX = 0xffff_ffff;
const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 2_500;
const WINDOWS_PROCESS_PROBE_MAX_BUFFER_BYTES = 4_096;
const WINDOWS_CAPTURE_HANDLE_ENV = 'WO_CAPTURE_AUDIO_WINDOW_HANDLE';
const WINDOWS_CURRENT_PROCESS_ID_ENV = 'WO_CAPTURE_AUDIO_CURRENT_PROCESS_ID';

const WINDOWS_WINDOW_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$rawHandle = [Environment]::GetEnvironmentVariable('WO_CAPTURE_AUDIO_WINDOW_HANDLE')
[long]$windowHandle = 0
if (-not [long]::TryParse(
  $rawHandle,
  [System.Globalization.NumberStyles]::Integer,
  [System.Globalization.CultureInfo]::InvariantCulture,
  [ref]$windowHandle
) -or $windowHandle -eq 0) {
  exit 10
}

$rawCurrentProcessId = [Environment]::GetEnvironmentVariable('WO_CAPTURE_AUDIO_CURRENT_PROCESS_ID')
[uint32]$currentProcessId = 0
if (-not [uint32]::TryParse(
  $rawCurrentProcessId,
  [System.Globalization.NumberStyles]::None,
  [System.Globalization.CultureInfo]::InvariantCulture,
  [ref]$currentProcessId
) -or $currentProcessId -eq 0) {
  exit 17
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

public static class WoCaptureWindowProcess {
  private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(
    IntPtr window,
    out uint processId
  );

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool EnumChildWindows(
    IntPtr parent,
    EnumWindowProc callback,
    IntPtr parameter
  );

  public static uint GetProcessId(long windowHandle) {
    uint processId;
    return GetWindowThreadProcessId(new IntPtr(windowHandle), out processId) == 0
      ? 0
      : processId;
  }

  public static uint[] GetChildProcessIds(long windowHandle) {
    var processIds = new HashSet<uint>();
    EnumChildWindows(
      new IntPtr(windowHandle),
      delegate(IntPtr child, IntPtr parameter) {
        uint processId;
        if (GetWindowThreadProcessId(child, out processId) != 0 && processId != 0) {
          processIds.Add(processId);
        }
        return true;
      },
      IntPtr.Zero
    );
    return processIds.ToArray();
  }
}
'@

[uint32]$windowProcessId = [WoCaptureWindowProcess]::GetProcessId($windowHandle)
if ($windowProcessId -eq 0) {
  exit 11
}

$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
$processById = @{}
foreach ($processRecord in $processes) {
  $processById[[string][uint32]$processRecord.ProcessId] = $processRecord
}

if ($null -eq $processById[[string]$currentProcessId]) {
  exit 18
}

$ownProcessIds = [System.Collections.Generic.HashSet[uint32]]::new()
$null = $ownProcessIds.Add($currentProcessId)
$ownProcessTreeComplete = $false
for ($depth = 0; $depth -lt 64; $depth += 1) {
  $added = $false
  foreach ($processRecord in $processes) {
    [uint32]$candidateProcessId = [uint32]$processRecord.ProcessId
    [uint32]$candidateParentProcessId = [uint32]$processRecord.ParentProcessId
    if (
      $candidateProcessId -ne 0 -and
      $ownProcessIds.Contains($candidateParentProcessId) -and
      $ownProcessIds.Add($candidateProcessId)
    ) {
      $added = $true
    }
  }
  if (-not $added) {
    $ownProcessTreeComplete = $true
    break
  }
}
if (-not $ownProcessTreeComplete) {
  exit 19
}

$target = $processById[[string]$windowProcessId]
if ($null -eq $target) {
  exit 12
}

if ([string]::Equals(
  [string]$target.Name,
  'ApplicationFrameHost.exe',
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  $candidates = @(
    foreach ($childProcessId in [WoCaptureWindowProcess]::GetChildProcessIds($windowHandle)) {
      if ($childProcessId -eq $windowProcessId) {
        continue
      }
      $candidate = $processById[[string]$childProcessId]
      if (
        $null -ne $candidate -and
        -not [string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)
      ) {
        $candidate
      }
    }
  )
  if ($candidates.Count -eq 0) {
    exit 13
  }
  $candidatePaths = @(
    $candidates |
      ForEach-Object { ([string]$_.ExecutablePath).ToUpperInvariant() } |
      Select-Object -Unique
  )
  if ($candidatePaths.Count -ne 1) {
    exit 14
  }
  $target = $candidates |
    Sort-Object -Property CreationDate, ProcessId |
    Select-Object -First 1
}

if ($ownProcessIds.Contains([uint32]$target.ProcessId)) {
  exit 20
}

if ([string]::IsNullOrWhiteSpace([string]$target.ExecutablePath)) {
  exit 15
}

$root = $target
for ($depth = 0; $depth -lt 64; $depth += 1) {
  [uint32]$parentProcessId = [uint32]$root.ParentProcessId
  if ($parentProcessId -eq 0) {
    break
  }
  $parent = $processById[[string]$parentProcessId]
  if (
    $null -eq $parent -or
    [string]::IsNullOrWhiteSpace([string]$parent.ExecutablePath) -or
    -not [string]::Equals(
      [string]$parent.ExecutablePath,
      [string]$root.ExecutablePath,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -or
    $parent.CreationDate -gt $root.CreationDate
  ) {
    break
  }
  $root = $parent
}

[uint32]$rootProcessId = [uint32]$root.ProcessId
if ($rootProcessId -eq 0) {
  exit 16
}
if ($ownProcessIds.Contains($rootProcessId)) {
  exit 21
}

[pscustomobject]@{ pid = $rootProcessId } | ConvertTo-Json -Compress
`;

const WINDOWS_WINDOW_PROCESS_ENCODED_COMMAND = Buffer.from(
  WINDOWS_WINDOW_PROCESS_SCRIPT,
  'utf16le',
).toString('base64');

interface CaptureSourceIdentity {
  readonly id: string;
  readonly name: string;
}

export interface CaptureAudioDevice {
  readonly id: string;
  readonly name: string;
}

interface ExecFileOptions {
  readonly encoding: 'utf8';
  readonly env: NodeJS.ProcessEnv;
  readonly maxBuffer: number;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type CaptureAudioExecFile = (
  executable: string,
  arguments_: readonly string[],
  options: ExecFileOptions,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

export interface WindowsWindowProcessResolverOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly execFile?: CaptureAudioExecFile;
  readonly currentProcessId?: number;
}

export type WindowsWindowProcessResolver = (
  windowHandle: string,
  currentProcessId: number,
) => Promise<number | null>;

export interface CaptureAudioTargetRequest {
  readonly source: CaptureSourceIdentity;
  readonly platform: NodeJS.Platform;
  readonly currentProcessId: number;
  readonly resolveWindowsWindowProcessId?: WindowsWindowProcessResolver;
}

interface ParsedCaptureSourceId {
  readonly kind: 'screen' | 'window';
  readonly sourceId: string;
  readonly nativeWindowId: string;
}

function isCanonicalSignedInt64(value: string): boolean {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value) || value === '-0') return false;
  try {
    const parsed = BigInt(value);
    return parsed >= SIGNED_INT64_MIN && parsed <= SIGNED_INT64_MAX;
  } catch {
    return false;
  }
}

function parseCaptureSourceId(value: string): ParsedCaptureSourceId | null {
  const match = /^(screen|window):([^:]+):([^:]+)$/u.exec(value);
  if (
    match === null ||
    !isCanonicalSignedInt64(match[2]!) ||
    !isCanonicalSignedInt64(match[3]!)
  ) {
    return null;
  }
  return Object.freeze({
    kind: match[1] as 'screen' | 'window',
    sourceId: match[2]!,
    nativeWindowId: match[3]!,
  });
}

export function parseWindowsCaptureWindowHandle(
  sourceId: string,
): string | null {
  const parsed = parseCaptureSourceId(sourceId);
  if (parsed === null || parsed.kind !== 'window' || parsed.sourceId === '0') {
    return null;
  }
  return parsed.sourceId;
}

function windowsSystemRoot(environment: NodeJS.ProcessEnv): string | null {
  const value = environment.SystemRoot ?? environment.WINDIR;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !win32.isAbsolute(value)
  ) {
    return null;
  }
  return win32.normalize(value);
}

const defaultExecFile: CaptureAudioExecFile = (
  executable,
  arguments_,
  options,
) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      executable,
      [...arguments_],
      options,
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

function parseWindowsProcessProbeOutput(
  stdout: string,
  stderr: string,
): number | null {
  if (
    stdout.length > 128 ||
    stderr.trim().length !== 0 ||
    stdout.trim().length === 0
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    value.pid > WINDOWS_PROCESS_ID_MAX
  ) {
    return null;
  }
  return value.pid;
}

export async function resolveWindowsWindowProcessId(
  windowHandle: string,
  options: WindowsWindowProcessResolverOptions = {},
): Promise<number | null> {
  if (
    !isCanonicalSignedInt64(windowHandle) ||
    windowHandle === '0' ||
    windowHandle === '-0'
  ) {
    return null;
  }
  const environment = options.environment ?? process.env;
  const currentProcessId = options.currentProcessId ?? process.pid;
  if (
    !Number.isSafeInteger(currentProcessId) ||
    currentProcessId <= 0 ||
    currentProcessId > WINDOWS_PROCESS_ID_MAX
  ) {
    return null;
  }
  const systemRoot = windowsSystemRoot(environment);
  if (systemRoot === null) return null;
  const executable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const execFile = options.execFile ?? defaultExecFile;
  try {
    const result = await execFile(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        WINDOWS_WINDOW_PROCESS_ENCODED_COMMAND,
      ],
      {
        encoding: 'utf8',
        env: {
          ...environment,
          [WINDOWS_CAPTURE_HANDLE_ENV]: windowHandle,
          [WINDOWS_CURRENT_PROCESS_ID_ENV]: String(currentProcessId),
        },
        maxBuffer: WINDOWS_PROCESS_PROBE_MAX_BUFFER_BYTES,
        timeout: WINDOWS_PROCESS_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return parseWindowsProcessProbeOutput(result.stdout, result.stderr);
  } catch {
    return null;
  }
}

export async function resolveCaptureAudioTarget(
  request: CaptureAudioTargetRequest,
): Promise<CaptureAudioDevice | null> {
  const parsed = parseCaptureSourceId(request.source.id);
  if (
    parsed === null ||
    !Number.isSafeInteger(request.currentProcessId) ||
    request.currentProcessId <= 0 ||
    request.currentProcessId > WINDOWS_PROCESS_ID_MAX
  ) {
    return null;
  }
  if (parsed.kind === 'screen') {
    return request.platform === 'win32' || request.platform === 'darwin'
      ? Object.freeze({
          id: 'loopbackWithoutChrome',
          name: 'System audio without WO playback',
        })
      : null;
  }
  if (request.platform !== 'win32') return null;

  const windowHandle = parseWindowsCaptureWindowHandle(request.source.id);
  if (windowHandle === null) return null;
  const processId =
    request.resolveWindowsWindowProcessId === undefined
      ? await resolveWindowsWindowProcessId(windowHandle, {
          currentProcessId: request.currentProcessId,
        })
      : await request.resolveWindowsWindowProcessId(
          windowHandle,
          request.currentProcessId,
        );
  if (
    processId === null ||
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    processId > WINDOWS_PROCESS_ID_MAX ||
    processId === request.currentProcessId
  ) {
    return null;
  }
  return Object.freeze({
    id: `applicationLoopback:${processId}`,
    name: 'Selected application audio',
  });
}
