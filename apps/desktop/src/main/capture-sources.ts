import type {
  CaptureSource,
  CaptureSourceBroker,
  DisplayCaptureRequest,
} from './capture-policy.js';
import { isDisplayCaptureRequestAllowed } from './capture-policy.js';
import { systemAudioModeForPlatform } from './permissions.js';

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
  return Object.freeze({
    async list(webContentsId: number) {
      const sources = await dependencies.desktopCapturer.getSources({
        types: ['screen', 'window'],
        fetchWindowIcons: false,
        thumbnailSize: { width: 200, height: 112 },
      });
      if (sources.length > MAX_CAPTURE_SOURCES) {
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
        return Object.freeze(summaries);
      } catch (error) {
        dependencies.broker.clear(webContentsId);
        throw error;
      }
    },
    select: (webContentsId: number, token: string) =>
      dependencies.broker.select(webContentsId, token),
    clear: (webContentsId: number) => dependencies.broker.clear(webContentsId),
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

export function installDisplayMediaHandler<
  Source extends CaptureSource,
>(input: {
  readonly session: DisplayMediaSession;
  readonly webContents: Readonly<{ id: number; mainFrame: unknown }>;
  readonly rendererEntry: string;
  readonly broker: CaptureSourceBroker<Source>;
  readonly platform?: NodeJS.Platform;
  readonly platformRelease: string;
}): void {
  const systemAudioMode = systemAudioModeForPlatform(
    input.platform ?? process.platform,
    input.platformRelease,
  );
  input.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (
        !isDisplayCaptureRequestAllowed(request, {
          mainFrame: input.webContents.mainFrame,
          rendererEntry: input.rendererEntry,
        })
      ) {
        callback({});
        return;
      }
      // When enabled, Electron's macOS picker is the sole source authority and
      // this handler is not expected to run. Fail closed if Electron falls
      // back to it instead of consuming a custom-picker broker token.
      if (systemAudioMode === 'native-picker') {
        callback({});
        return;
      }
      if (request.audioRequested && systemAudioMode !== 'loopback') {
        callback({});
        return;
      }
      try {
        const video = input.broker.consumeSelected(input.webContents.id);
        const audio =
          request.audioRequested && systemAudioMode === 'loopback'
            ? 'loopback'
            : undefined;
        callback(audio !== undefined ? { video, audio } : { video });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: systemAudioMode === 'native-picker' },
  );
}
