import type {
  CaptureSource,
  CaptureSourceBroker,
  DisplayCaptureRequest,
} from './capture-policy.js';
import {
  resolveCaptureAudioTarget,
  type CaptureAudioDevice,
  type WindowsWindowProcessResolver,
} from './capture-audio-target.js';
import { isDisplayCaptureRequestAllowed } from './capture-policy.js';
import { systemAudioModeForPlatform } from './permissions.js';
import { DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL } from '../ipc-channels.js';

export interface DesktopCaptureSource extends CaptureSource {
  readonly thumbnail: {
    toDataURL(): string;
    getSize(): Readonly<{ width: number; height: number }>;
  };
}

export interface CaptureSourceSummary {
  readonly token: string;
  readonly name: string;
  readonly kind: 'screen' | 'window';
  readonly thumbnailDataUrl: string;
}

export interface CaptureSourceService {
  list(webContentsId: number): Promise<readonly CaptureSourceSummary[]>;
  select(webContentsId: number, token: string): void;
  clear(webContentsId: number): void;
}

export interface CaptureSourceServiceDependencies<
  Source extends DesktopCaptureSource,
> {
  readonly broker: CaptureSourceBroker<Source>;
  readonly desktopCapturer: {
    getSources(options: {
      readonly types: readonly ['screen', 'window'];
      readonly fetchWindowIcons: false;
      readonly thumbnailSize: Readonly<{ width: 200; height: 112 }>;
    }): Promise<readonly Source[]>;
  };
}

const MAX_CAPTURE_SOURCES = 100;
const MAX_THUMBNAIL_BYTES = 512 * 1_024;
const MAX_TOTAL_THUMBNAIL_BYTES = 8 * 1_024 * 1_024;
const MAX_THUMBNAIL_WIDTH = 400;
const MAX_THUMBNAIL_HEIGHT = 224;
const CAPTURE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

// 1×1 transparent PNG used as a placeholder for sources whose thumbnail
// failed to render (minimized windows, off-screen windows, protected
// surfaces). The source still appears in the picker so the user can select it.
const PLACEHOLDER_THUMBNAIL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

function sourceKind(id: string): 'screen' | 'window' {
  if (id.startsWith('screen:')) return 'screen';
  if (id.startsWith('window:')) return 'window';
  throw new TypeError('Invalid capture source type');
}

function thumbnailData(source: DesktopCaptureSource): {
  readonly value: string;
  readonly bytes: number;
} {
  const size = source.thumbnail.getSize();
  // Sources with a 0×0 thumbnail (minimized/off-screen windows, or windows
  // not yet rendered) get a lightweight placeholder instead of being dropped.
  // The source still appears in the picker so the user can select it.
  if (size.width === 0 && size.height === 0) {
    return {
      value: PLACEHOLDER_THUMBNAIL,
      bytes: PLACEHOLDER_THUMBNAIL.length,
    };
  }
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > MAX_THUMBNAIL_WIDTH ||
    size.height > MAX_THUMBNAIL_HEIGHT
  ) {
    throw new RangeError('Capture source thumbnail dimensions exceed limits');
  }
  const value = source.thumbnail.toDataURL();
  const bytes = Buffer.byteLength(value, 'ascii');
  if (
    !value.startsWith('data:image/png;base64,') ||
    bytes > MAX_THUMBNAIL_BYTES
  ) {
    throw new RangeError('Capture source thumbnail exceeds its limit');
  }
  return { value, bytes };
}

export function createCaptureSourceService<Source extends DesktopCaptureSource>(
  dependencies: CaptureSourceServiceDependencies<Source>,
): CaptureSourceService {
  const activeListings = new Map<number, object>();

  return Object.freeze({
    async list(webContentsId: number) {
      const listing = Object.freeze({});
      activeListings.set(webContentsId, listing);
      let sources: readonly Source[];
      try {
        sources = await dependencies.desktopCapturer.getSources({
          types: ['screen', 'window'],
          fetchWindowIcons: false,
          thumbnailSize: { width: 200, height: 112 },
        });
      } catch (error) {
        if (activeListings.get(webContentsId) === listing) {
          activeListings.delete(webContentsId);
        }
        throw error;
      }
      if (activeListings.get(webContentsId) !== listing) {
        throw new Error('Capture source listing was superseded');
      }
      if (sources.length > MAX_CAPTURE_SOURCES) {
        activeListings.delete(webContentsId);
        dependencies.broker.clear(webContentsId);
        throw new RangeError('Too many capture sources');
      }
      try {
        let totalBytes = 0;
        const available: Array<{
          readonly source: Source;
          readonly kind: 'screen' | 'window';
          readonly thumbnailDataUrl: string;
        }> = [];
        for (const source of sources) {
          const thumbnail = thumbnailData(source);
          totalBytes += thumbnail.bytes;
          if (totalBytes > MAX_TOTAL_THUMBNAIL_BYTES) {
            throw new RangeError(
              'Capture source thumbnails exceed their limit',
            );
          }
          available.push({
            source,
            kind: sourceKind(source.id),
            thumbnailDataUrl: thumbnail.value,
          });
        }
        const tokens = dependencies.broker.replaceAvailable(
          webContentsId,
          available.map(({ source }) => source),
        );
        const summaries = available.map((item, index) => {
          return Object.freeze({
            token: tokens[index]!.token,
            name: tokens[index]!.name,
            kind: item.kind,
            thumbnailDataUrl: item.thumbnailDataUrl,
          });
        });
        activeListings.delete(webContentsId);
        return Object.freeze(summaries);
      } catch (error) {
        if (activeListings.get(webContentsId) === listing) {
          activeListings.delete(webContentsId);
          dependencies.broker.clear(webContentsId);
        }
        throw error;
      }
    },
    select: (webContentsId: number, token: string) =>
      dependencies.broker.select(webContentsId, token),
    clear(webContentsId: number) {
      activeListings.delete(webContentsId);
      dependencies.broker.clear(webContentsId);
    },
  });
}

export interface DisplayMediaSession {
  setDisplayMediaRequestHandler(
    handler: (
      request: DisplayCaptureRequest,
      callback: (
        streams: Readonly<{
          video?: CaptureSource;
          audio?: 'loopback' | 'loopbackWithMute';
        }>,
      ) => void,
    ) => void,
    options: Readonly<{ useSystemPicker: boolean }>,
  ): void;
}

function grantCaptureAudioDevice(
  callback: (
    streams: Readonly<{
      video?: CaptureSource;
      audio?: 'loopback' | 'loopbackWithMute';
    }>,
  ) => void,
  video: CaptureSource,
  audio: CaptureAudioDevice,
): void {
  // Electron 43 keeps an intentionally undocumented { id, name } escape hatch
  // in DisplayMediaDeviceChosen. Keep the public Session type narrow and
  // isolate the runtime-only device descriptor at this boundary.
  const callbackWithAudioDevice = callback as unknown as (
    streams: Readonly<{
      video: CaptureSource;
      audio: CaptureAudioDevice;
    }>,
  ) => void;
  callbackWithAudioDevice({ video, audio });
}

export function installDisplayMediaHandler<
  Source extends CaptureSource,
>(input: {
  readonly session: DisplayMediaSession;
  readonly webContents: Readonly<{
    id: number;
    mainFrame: unknown;
    send?: (channel: string, value: unknown) => void;
  }>;
  readonly rendererEntry: string;
  readonly broker: CaptureSourceBroker<Source>;
  readonly platform?: NodeJS.Platform;
  readonly platformRelease: string;
  readonly currentProcessId?: number;
  readonly resolveWindowsWindowProcessId?: WindowsWindowProcessResolver;
}): void {
  const platform = input.platform ?? process.platform;
  const currentProcessId = input.currentProcessId ?? process.pid;
  const systemAudioMode = systemAudioModeForPlatform(
    platform,
    input.platformRelease,
  );
  input.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      let completed = false;
      let diagnosticReported = false;
      const reportCaptureDiagnostic = (
        stage:
          'AUTHORIZATION' | 'DISPLAY_MEDIA_HANDLER' | 'WINDOW_AUDIO_TARGET',
        code: string,
      ): void => {
        if (
          diagnosticReported ||
          input.webContents.send === undefined ||
          !CAPTURE_DIAGNOSTIC_CODE.test(code)
        ) {
          return;
        }
        diagnosticReported = true;
        try {
          input.webContents.send(
            DESKTOP_CAPTURE_DIAGNOSTIC_CHANNEL,
            Object.freeze({ stage, code }),
          );
        } catch {
          // The renderer can disappear while an asynchronous PID probe settles.
        }
      };
      const complete = (
        streams: Readonly<{
          video?: CaptureSource;
          audio?: 'loopback' | 'loopbackWithMute';
        }>,
      ): void => {
        if (completed) return;
        completed = true;
        callback(streams);
      };
      if (
        !isDisplayCaptureRequestAllowed(request, {
          mainFrame: input.webContents.mainFrame,
          rendererEntry: input.rendererEntry,
        })
      ) {
        reportCaptureDiagnostic('AUTHORIZATION', 'REQUEST_NOT_ALLOWED');
        complete({});
        return;
      }
      // When enabled, Electron's macOS picker is the sole source authority and
      // this handler is not expected to run. Fail closed if Electron falls
      // back to it instead of consuming a custom-picker broker token.
      if (systemAudioMode === 'native-picker') {
        reportCaptureDiagnostic(
          'AUTHORIZATION',
          'NATIVE_PICKER_HANDLER_FALLBACK',
        );
        complete({});
        return;
      }
      if (request.audioRequested && systemAudioMode !== 'loopback') {
        reportCaptureDiagnostic('AUTHORIZATION', 'SYSTEM_AUDIO_UNSUPPORTED');
        complete({});
        return;
      }
      try {
        if (!request.audioRequested) {
          complete({
            video: input.broker.consumeSelected(input.webContents.id),
          });
          return;
        }
        const video = input.broker.peekSelected(input.webContents.id);
        void resolveCaptureAudioTarget({
          source: video,
          platform,
          currentProcessId,
          resolveWindowsWindowProcessId: input.resolveWindowsWindowProcessId,
          onFailure: (code) =>
            reportCaptureDiagnostic('WINDOW_AUDIO_TARGET', code),
        })
          .then((audio) => {
            if (audio === null) {
              reportCaptureDiagnostic(
                'WINDOW_AUDIO_TARGET',
                'AUDIO_TARGET_UNAVAILABLE',
              );
              complete({});
              return;
            }
            const committed = input.broker.consumeSelectedIfUnchanged(
              input.webContents.id,
              video,
            );
            grantCaptureAudioDevice(complete, committed, audio);
          })
          .catch(() => {
            reportCaptureDiagnostic(
              'DISPLAY_MEDIA_HANDLER',
              'AUDIO_TARGET_OR_SELECTION_REJECTED',
            );
            complete({});
          });
      } catch {
        reportCaptureDiagnostic(
          'DISPLAY_MEDIA_HANDLER',
          'SOURCE_SELECTION_REJECTED',
        );
        complete({});
      }
    },
    { useSystemPicker: systemAudioMode === 'native-picker' },
  );
}
