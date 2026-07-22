import type {
  CaptureSource,
  CaptureSourceBroker,
  DisplayCaptureRequest,
} from './capture-policy.js';
import { isDisplayCaptureRequestAllowed } from './capture-policy.js';

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
      readonly thumbnailSize: Readonly<{ width: 320; height: 180 }>;
    }): Promise<readonly Source[]>;
  };
}

const MAX_CAPTURE_SOURCES = 100;
const MAX_THUMBNAIL_BYTES = 512 * 1_024;
const MAX_TOTAL_THUMBNAIL_BYTES = 8 * 1_024 * 1_024;
const MAX_THUMBNAIL_WIDTH = 640;
const MAX_THUMBNAIL_HEIGHT = 360;

function sourceKind(id: string): 'screen' | 'window' {
  if (id.startsWith('screen:')) return 'screen';
  if (id.startsWith('window:')) return 'window';
  throw new TypeError('Invalid capture source type');
}

function thumbnailData(source: DesktopCaptureSource): {
  readonly value: string;
  readonly bytes: number;
} | null {
  const size = source.thumbnail.getSize();
  if (size.width === 0 && size.height === 0) return null;
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
        thumbnailSize: { width: 320, height: 180 },
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
          if (thumbnail === null) continue;
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
      callback: (streams: Readonly<{
        video?: CaptureSource;
        audio?: 'loopback' | 'loopbackWithMute';
      }>) => void,
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
}): void {
  // Use the OS-native screen picker when the renderer requests system audio
  // (macOS loopback), because loopback capture is only available through the
  // system picker on macOS. Otherwise use the custom in-app picker for a
  // smoother UX.
  const useSystemPicker = true;
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
      try {
        const video = input.broker.consumeSelected(input.webContents.id);
        // Provide loopback audio when the renderer asked for it. On macOS
        // the user must also check "Share Computer Audio" in the system
        // dialog; we can only enable the capability, not force it.
        const audio = request.audioRequested ? 'loopback' : undefined;
        callback(audio !== undefined ? { video, audio } : { video });
      } catch {
        // If the broker has no selection (system picker path), let the OS
        // handle both video and audio selection natively.
        const audio = request.audioRequested ? 'loopback' : undefined;
        callback(audio !== undefined ? { audio } : {});
      }
    },
    { useSystemPicker },
  );
}
