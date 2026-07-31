import { execFile as nodeExecFile } from 'node:child_process';
import { win32 } from 'node:path';

const SIGNED_INT64_MIN = -(2n ** 63n);
const SIGNED_INT64_MAX = 2n ** 63n - 1n;
const WINDOWS_PROCESS_ID_MAX = 0xffff_ffff;
const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_PROCESS_PROBE_MAX_BUFFER_BYTES = 4_096;
const WINDOWS_CAPTURE_HANDLE_ENV = 'WO_CAPTURE_AUDIO_WINDOW_HANDLE';
const WINDOWS_CURRENT_PROCESS_ID_ENV = 'WO_CAPTURE_AUDIO_CURRENT_PROCESS_ID';

const WINDOWS_WINDOW_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Suppress the "preparing for first-time use of module" progress record that
# the PowerShell host serializes as CLIXML onto stderr while the probe runs.
# Any bytes on stderr cause the Node-side output parser to fail closed, so the
# probe must keep stderr empty even on a cold module-analysis cache.
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
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
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class WoCaptureWindowProcessResult {
  public int ExitCode { get; set; }
  public uint ProcessId { get; set; }
}

public static class WoCaptureWindowProcess {
  private delegate bool EnumWindowProc(IntPtr window, IntPtr parameter);

  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const uint Th32csSnapProcess = 0x00000002;
  private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

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

  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int GetClassName(
    IntPtr window,
    StringBuilder className,
    int maximumCount
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(
    uint desiredAccess,
    bool inheritHandle,
    uint processId
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool QueryFullProcessImageName(
    IntPtr process,
    uint flags,
    StringBuilder executableName,
    ref uint size
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetProcessTimes(
    IntPtr process,
    out FileTime creationTime,
    out FileTime exitTime,
    out FileTime kernelTime,
    out FileTime userTime
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(
    uint flags,
    uint processId
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32First(
    IntPtr snapshot,
    ref ProcessEntry entry
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool Process32Next(
    IntPtr snapshot,
    ref ProcessEntry entry
  );

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ProcessEntry {
    public uint Size;
    public uint UsageCount;
    public uint ProcessId;
    public IntPtr DefaultHeapId;
    public uint ModuleId;
    public uint ThreadCount;
    public uint ParentProcessId;
    public int BasePriority;
    public uint Flags;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string ExecutableFile;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime {
    public uint Low;
    public uint High;
  }

  private sealed class ProcessIdentity {
    public string ExecutablePath { get; set; }
    public long CreationTime { get; set; }
  }

  private static WoCaptureWindowProcessResult Failure(int exitCode) {
    return new WoCaptureWindowProcessResult {
      ExitCode = exitCode,
      ProcessId = 0
    };
  }

  private static WoCaptureWindowProcessResult Success(uint processId) {
    return new WoCaptureWindowProcessResult {
      ExitCode = 0,
      ProcessId = processId
    };
  }

  private static bool TrySnapshotProcesses(
    out Dictionary<uint, uint> parentByProcessId
  ) {
    parentByProcessId = new Dictionary<uint, uint>();
    IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
    if (snapshot == InvalidHandleValue) {
      return false;
    }
    try {
      var entry = new ProcessEntry();
      entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32First(snapshot, ref entry)) {
        return false;
      }
      do {
        if (entry.ProcessId != 0) {
          parentByProcessId[entry.ProcessId] = entry.ParentProcessId;
        }
        entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      } while (Process32Next(snapshot, ref entry));
      return parentByProcessId.Count != 0;
    } finally {
      CloseHandle(snapshot);
    }
  }

  private static ProcessIdentity GetProcessIdentity(uint processId) {
    IntPtr process = OpenProcess(
      ProcessQueryLimitedInformation,
      false,
      processId
    );
    if (process == IntPtr.Zero) {
      return null;
    }
    try {
      FileTime creationTime;
      FileTime exitTime;
      FileTime kernelTime;
      FileTime userTime;
      if (
        !GetProcessTimes(
          process,
          out creationTime,
          out exitTime,
          out kernelTime,
          out userTime
        )
      ) {
        return null;
      }
      uint capacity = 260;
      while (capacity <= 32768) {
        var path = new StringBuilder((int)capacity);
        uint length = capacity;
        if (QueryFullProcessImageName(process, 0, path, ref length)) {
          return new ProcessIdentity {
            ExecutablePath = path.ToString(),
            CreationTime =
              ((long)creationTime.High << 32) | (long)creationTime.Low
          };
        }
        if (Marshal.GetLastWin32Error() != 122) {
          return null;
        }
        capacity *= 2;
      }
      return null;
    } finally {
      CloseHandle(process);
    }
  }

  private static bool IsApplicationFrameHost(string executablePath) {
    return string.Equals(
      Path.GetDirectoryName(executablePath),
      Environment.SystemDirectory,
      StringComparison.OrdinalIgnoreCase
    ) && string.Equals(
      Path.GetFileName(executablePath),
      "ApplicationFrameHost.exe",
      StringComparison.OrdinalIgnoreCase
    );
  }

  private static uint GetUwpApplicationProcessId(IntPtr window) {
    uint applicationProcessId = 0;
    EnumChildWindows(
      window,
      delegate(IntPtr child, IntPtr parameter) {
        var className = new StringBuilder(256);
        if (
          GetClassName(child, className, className.Capacity) > 0 &&
          string.Equals(
            className.ToString(),
            "Windows.UI.Core.CoreWindow",
            StringComparison.Ordinal
          )
        ) {
          uint processId;
          if (
            GetWindowThreadProcessId(child, out processId) != 0 &&
            processId != 0
          ) {
            applicationProcessId = processId;
            return false;
          }
        }
        return true;
      },
      IntPtr.Zero
    );
    return applicationProcessId;
  }

  private static HashSet<uint> BuildProcessTree(
    uint rootProcessId,
    Dictionary<uint, uint> parentByProcessId
  ) {
    var processIds = new HashSet<uint>();
    processIds.Add(rootProcessId);
    for (int depth = 0; depth <= parentByProcessId.Count; depth += 1) {
      bool added = false;
      foreach (KeyValuePair<uint, uint> process in parentByProcessId) {
        if (
          process.Key != 0 &&
          processIds.Contains(process.Value) &&
          processIds.Add(process.Key)
        ) {
          added = true;
        }
      }
      if (!added) {
        return processIds;
      }
    }
    return null;
  }

  private static uint GetGenericApplicationRootProcessId(
    uint processId,
    ProcessIdentity processIdentity,
    Dictionary<uint, uint> parentByProcessId
  ) {
    uint rootProcessId = processId;
    var visited = new HashSet<uint>();
    visited.Add(processId);
    uint parentProcessId;
    while (
      parentByProcessId.TryGetValue(rootProcessId, out parentProcessId) &&
      parentProcessId != 0 &&
      visited.Add(parentProcessId)
    ) {
      ProcessIdentity parentIdentity = GetProcessIdentity(parentProcessId);
      if (
        parentIdentity == null ||
        string.IsNullOrWhiteSpace(parentIdentity.ExecutablePath) ||
        !string.Equals(
          parentIdentity.ExecutablePath,
          processIdentity.ExecutablePath,
          StringComparison.OrdinalIgnoreCase
        ) ||
        parentIdentity.CreationTime > processIdentity.CreationTime
      ) {
        break;
      }
      rootProcessId = parentProcessId;
      processIdentity = parentIdentity;
    }
    return rootProcessId;
  }

  public static WoCaptureWindowProcessResult Resolve(
    long windowHandle,
    uint currentProcessId
  ) {
    IntPtr window = new IntPtr(windowHandle);
    uint windowProcessId;
    if (
      GetWindowThreadProcessId(window, out windowProcessId) == 0 ||
      windowProcessId == 0
    ) {
      return Failure(11);
    }

    Dictionary<uint, uint> parentByProcessId;
    if (
      !TrySnapshotProcesses(out parentByProcessId) ||
      !parentByProcessId.ContainsKey(currentProcessId)
    ) {
      return Failure(18);
    }

    HashSet<uint> ownProcessIds = BuildProcessTree(
      currentProcessId,
      parentByProcessId
    );
    if (ownProcessIds == null) {
      return Failure(19);
    }
    if (ownProcessIds.Contains(windowProcessId)) {
      return Failure(20);
    }

    ProcessIdentity processIdentity = GetProcessIdentity(windowProcessId);
    if (
      processIdentity == null ||
      string.IsNullOrWhiteSpace(processIdentity.ExecutablePath)
    ) {
      return Failure(15);
    }

    uint rootProcessId;
    if (IsApplicationFrameHost(processIdentity.ExecutablePath)) {
      rootProcessId = GetUwpApplicationProcessId(window);
      if (rootProcessId == 0) {
        return Failure(13);
      }
    } else {
      rootProcessId = GetGenericApplicationRootProcessId(
        windowProcessId,
        processIdentity,
        parentByProcessId
      );
    }

    if (rootProcessId == 0) {
      return Failure(16);
    }
    if (ownProcessIds.Contains(rootProcessId)) {
      return Failure(21);
    }
    return Success(rootProcessId);
  }
}
'@

$result = [WoCaptureWindowProcess]::Resolve(
  $windowHandle,
  $currentProcessId
)
if ($result.ExitCode -ne 0) {
  exit $result.ExitCode
}

[pscustomobject]@{ pid = [uint32]$result.ProcessId } |
  ConvertTo-Json -Compress
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
  readonly onFailure?: (code: CaptureAudioTargetFailureCode) => void;
}

export type WindowsWindowProcessResolver = (
  windowHandle: string,
  currentProcessId: number,
  onFailure?: (code: CaptureAudioTargetFailureCode) => void,
) => Promise<number | null>;

export interface CaptureAudioTargetRequest {
  readonly source: CaptureSourceIdentity;
  readonly platform: NodeJS.Platform;
  readonly currentProcessId: number;
  readonly resolveWindowsWindowProcessId?: WindowsWindowProcessResolver;
  readonly onFailure?: (code: CaptureAudioTargetFailureCode) => void;
}

export type CaptureAudioTargetFailureCode =
  | 'CURRENT_PROCESS_INVALID'
  | 'PLATFORM_UNSUPPORTED'
  | 'PROBE_OUTPUT_INVALID'
  | 'PROCESS_ID_INVALID'
  | 'PROCESS_UNRESOLVED'
  | 'SOURCE_ID_INVALID'
  | 'SYSTEM_ROOT_INVALID'
  | 'TARGET_IS_WO'
  | 'WINDOW_HANDLE_INVALID'
  | `PROBE_${string}`;

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

// PowerShell serializes host-stream records (progress, verbose, debug,
// warning) as CLIXML onto stderr when output is redirected or the session is
// non-interactive. The probe sets $ProgressPreference='SilentlyContinue', but
// keep a defense-in-depth filter so a host-level module-prep record such as
// "正在准备首次使用模块" cannot cause the output parser to fail closed. Only
// genuinely textual error output on stderr is treated as a probe failure.
const POWERSHELL_CLIXML_PREFIX = '#< CLIXML';

function isHarmlessPowerShellStderr(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  // Accept a single CLIXML document covering the whole stream as host-stream
  // noise (progress/verbose records serialized by the non-interactive host).
  // If anything else trails the document, treat stderr as a real probe error.
  if (
    trimmed.startsWith(POWERSHELL_CLIXML_PREFIX) &&
    trimmed.endsWith('</Objs>') &&
    trimmed.includes('http://schemas.microsoft.com/powershell/2004/04')
  ) {
    return true;
  }
  return false;
}

function parseWindowsProcessProbeOutput(
  stdout: string,
  stderr: string,
): number | null {
  if (
    stdout.length > 128 ||
    stdout.trim().length === 0 ||
    !isHarmlessPowerShellStderr(stderr)
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

function windowsProcessProbeFailureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  if ('killed' in error && error.killed === true) return 'TERMINATED';
  if (!('code' in error)) return 'UNKNOWN';
  const code = error.code;
  if (typeof code === 'string' && /^[A-Z0-9_-]{1,32}$/u.test(code)) {
    return code;
  }
  return typeof code === 'number' && Number.isSafeInteger(code)
    ? `EXIT_${code}`
    : 'UNKNOWN';
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
    options.onFailure?.('WINDOW_HANDLE_INVALID');
    return null;
  }
  const environment = options.environment ?? process.env;
  const currentProcessId = options.currentProcessId ?? process.pid;
  if (
    !Number.isSafeInteger(currentProcessId) ||
    currentProcessId <= 0 ||
    currentProcessId > WINDOWS_PROCESS_ID_MAX
  ) {
    options.onFailure?.('CURRENT_PROCESS_INVALID');
    return null;
  }
  const systemRoot = windowsSystemRoot(environment);
  if (systemRoot === null) {
    options.onFailure?.('SYSTEM_ROOT_INVALID');
    return null;
  }
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
    const processId = parseWindowsProcessProbeOutput(
      result.stdout,
      result.stderr,
    );
    if (processId === null) options.onFailure?.('PROBE_OUTPUT_INVALID');
    return processId;
  } catch (error) {
    const code = windowsProcessProbeFailureCode(error);
    console.warn(
      `[capture-audio-target] Windows process probe failed: ${code}`,
    );
    options.onFailure?.(`PROBE_${code}`);
    return null;
  }
}

export async function resolveCaptureAudioTarget(
  request: CaptureAudioTargetRequest,
): Promise<CaptureAudioDevice | null> {
  let failureReported = false;
  const reportFailure = (code: CaptureAudioTargetFailureCode): void => {
    if (failureReported) return;
    failureReported = true;
    request.onFailure?.(code);
  };
  const parsed = parseCaptureSourceId(request.source.id);
  if (parsed === null) {
    reportFailure('SOURCE_ID_INVALID');
    return null;
  }
  if (
    !Number.isSafeInteger(request.currentProcessId) ||
    request.currentProcessId <= 0 ||
    request.currentProcessId > WINDOWS_PROCESS_ID_MAX
  ) {
    reportFailure('CURRENT_PROCESS_INVALID');
    return null;
  }
  if (parsed.kind === 'screen') {
    if (request.platform !== 'win32' && request.platform !== 'darwin') {
      reportFailure('PLATFORM_UNSUPPORTED');
      return null;
    }
    return Object.freeze({
      id: 'loopbackWithoutChrome',
      name: 'System audio without WO playback',
    });
  }
  if (request.platform !== 'win32') {
    reportFailure('PLATFORM_UNSUPPORTED');
    return null;
  }

  const windowHandle = parseWindowsCaptureWindowHandle(request.source.id);
  if (windowHandle === null) {
    reportFailure('WINDOW_HANDLE_INVALID');
    return null;
  }
  const processId =
    request.resolveWindowsWindowProcessId === undefined
      ? await resolveWindowsWindowProcessId(windowHandle, {
          currentProcessId: request.currentProcessId,
          onFailure: reportFailure,
        })
      : await request.resolveWindowsWindowProcessId(
          windowHandle,
          request.currentProcessId,
          reportFailure,
        );
  if (processId === null) {
    reportFailure('PROCESS_UNRESOLVED');
    return null;
  }
  if (
    !Number.isSafeInteger(processId) ||
    processId <= 0 ||
    processId > WINDOWS_PROCESS_ID_MAX
  ) {
    reportFailure('PROCESS_ID_INVALID');
    return null;
  }
  if (processId === request.currentProcessId) {
    reportFailure('TARGET_IS_WO');
    return null;
  }
  return Object.freeze({
    id: `applicationLoopback:${processId}`,
    name: 'Selected application audio',
  });
}
