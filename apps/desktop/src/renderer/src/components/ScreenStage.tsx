import { useCallback, useEffect, useRef, useState } from 'react';
import { Expand, Monitor, MonitorUp, Shrink, ZoomOut } from 'lucide-react';

import type { ScreenShareState } from '../media/screen-controller.js';

interface PanOffset {
  readonly x: number;
  readonly y: number;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.15;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampPan(
  pan: PanOffset,
  width: number,
  height: number,
  zoom: number,
): PanOffset {
  if (zoom <= 1) return { x: 0, y: 0 };
  // video 是 width:100% height:100%，放大后多出的尺寸就是可平移的范围。
  const maxX = ((zoom - 1) * width) / 2;
  const maxY = ((zoom - 1) * height) / 2;
  return {
    x: clamp(pan.x, -maxX, maxX),
    y: clamp(pan.y, -maxY, maxY),
  };
}

function isFullscreenElement(
  element: HTMLElement | null,
  doc: Document,
): boolean {
  return doc.fullscreenElement === element;
}

export function ScreenStage({
  localTrack,
  remoteTrack,
  localState,
  remoteOwnerName,
  remoteBitrateBps,
  onPresentationVideo,
}: {
  readonly localTrack: MediaStreamTrack | null;
  readonly remoteTrack: MediaStreamTrack | null;
  readonly localState: ScreenShareState;
  readonly remoteOwnerName: string | null;
  readonly remoteBitrateBps: number | null;
  readonly onPresentationVideo?: (video: HTMLVideoElement | null) => void;
}) {
  const stageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PanOffset>({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragOrigin = useRef<PanOffset | null>(null);

  const localSharing = localState === 'sharing';
  const showRemoteTrack = remoteOwnerName !== null && remoteTrack !== null;
  const showLocalTrack =
    !showRemoteTrack && localSharing && localTrack !== null;
  const presentationTrack = showRemoteTrack
    ? remoteTrack
    : showLocalTrack
      ? localTrack
      : null;
  const live = presentationTrack !== null;
  const viewerControls = showRemoteTrack || showLocalTrack;
  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Track switches (remote → local, or different source) must reset the
  // viewport so the new feed is shown fitted, not at the previous zoom.
  useEffect(() => {
    reset();
  }, [presentationTrack, reset]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (presentationTrack === null || typeof MediaStream === 'undefined') {
      video.srcObject = null;
      return;
    }
    video.srcObject = new MediaStream([presentationTrack]);
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [presentationTrack]);

  const waitingForRemoteTrack =
    remoteOwnerName !== null && remoteTrack === null;

  useEffect(() => {
    const video = showRemoteTrack ? videoRef.current : null;
    onPresentationVideo?.(video);
    return () => onPresentationVideo?.(null);
  }, [onPresentationVideo, showRemoteTrack]);

  // Wheel zoom focused on the cursor, and pan-by-drag. Both need
  // non-passive listeners (wheel) and document-level capture (drag).
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null || !live) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Cursor position relative to the stage centre (the transform origin).
      const cursorX = event.clientX - rect.left - rect.width / 2;
      const cursorY = event.clientY - rect.top - rect.height / 2;
      setZoom((currentZoom) => {
        const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const nextZoom = clamp(currentZoom * factor, MIN_ZOOM, MAX_ZOOM);
        if (nextZoom === currentZoom) return currentZoom;
        setPan((currentPan) => {
          // Keep the point under the cursor anchored: the same stage-space
          // point stays under the cursor after the scale change.
          // p' = cursor - (cursor - p) * (nextZoom / currentZoom)
          const ratio = nextZoom / currentZoom;
          const raw = {
            x: cursorX - (cursorX - currentPan.x) * ratio,
            y: cursorY - (cursorY - currentPan.y) * ratio,
          };
          return clampPan(raw, rect.width, rect.height, nextZoom);
        });
        return nextZoom;
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [live]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent): void => {
      if (dragOrigin.current === null) return;
      const stage = stageRef.current;
      if (stage === null) return;
      const rect = stage.getBoundingClientRect();
      const dx = event.clientX - dragOrigin.current.x;
      const dy = event.clientY - dragOrigin.current.y;
      setPan((current) =>
        clampPan(
          { x: current.x + dx, y: current.y + dy },
          rect.width,
          rect.height,
          zoom,
        ),
      );
      // Re-anchor so subsequent move events use the latest position.
      dragOrigin.current = { x: event.clientX, y: event.clientY };
    };
    const onUp = (): void => {
      dragOrigin.current = null;
      setDragging(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging, zoom]);

  useEffect(() => {
    const video = videoRef.current;
    const doc = video?.ownerDocument ?? document;
    const syncFullscreen = (): void => {
      setFullscreen(isFullscreenElement(videoRef.current, doc));
    };
    doc.addEventListener('fullscreenchange', syncFullscreen);
    syncFullscreen();
    return () => {
      doc.removeEventListener('fullscreenchange', syncFullscreen);
    };
  }, [live]);

  // Leaving the live state should exit fullscreen and reset the viewport.
  useEffect(() => {
    if (live) return;
    reset();
    const stage = stageRef.current;
    const doc = stage?.ownerDocument;
    if (
      stage !== null &&
      stage !== undefined &&
      doc !== undefined &&
      isFullscreenElement(stage, doc)
    ) {
      void doc.exitFullscreen().catch(() => undefined);
    }
  }, [live, reset]);

  const onStagePointerDown = (event: React.MouseEvent): void => {
    if (zoom === 1) return;
    // Only react to clicks on the stage background / video, not on the
    // floating controls (they stopPropagation implicitly via button clicks).
    event.preventDefault();
    dragOrigin.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
  };

  const onDoubleClick = (): void => {
    reset();
  };

  const toggleFullscreen = (): void => {
    const video = videoRef.current;
    if (video === null) return;
    const doc = video.ownerDocument;
    if (isFullscreenElement(video, doc)) {
      void doc.exitFullscreen().catch(() => undefined);
      return;
    }
    void video.requestFullscreen().catch(() => undefined);
  };

  const cursor = zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'default';

  return (
    <section
      ref={stageRef}
      className={`screen-stage${live ? ' screen-stage--live' : ''}${fullscreen ? ' screen-stage--fullscreen' : ''}`}
      aria-label="共享屏幕"
      data-zoom={zoom.toFixed(2)}
    >
      {presentationTrack !== null && (
        <video
          ref={videoRef}
          className="remote-screen-video"
          aria-label={
            showRemoteTrack
              ? `${remoteOwnerName ?? '对方'}的共享屏幕`
              : '本地共享预览'
          }
          autoPlay
          muted={showLocalTrack}
          playsInline
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            cursor,
          }}
          onMouseDown={onStagePointerDown}
          onDoubleClick={onDoubleClick}
        />
      )}
      {presentationTrack === null && (
        <div className={`screen-empty${localSharing ? ' local-sharing' : ''}`}>
          {localSharing ? (
            <MonitorUp size={42} strokeWidth={1.4} />
          ) : (
            <Monitor size={42} strokeWidth={1.4} />
          )}
          <h2>
            {localSharing
              ? '您正在共享屏幕'
              : waitingForRemoteTrack
                ? `正在接收${remoteOwnerName}的屏幕`
                : '等待屏幕共享'}
          </h2>
        </div>
      )}
      {viewerControls && (
        <div className="screen-view-controls" role="toolbar" aria-label="画面控制">
          {zoom > 1 && (
            <button
              type="button"
              title="还原"
              aria-label="还原缩放"
              onClick={reset}
            >
              <ZoomOut size={15} />
              还原
            </button>
          )}
          <button
            type="button"
            className={fullscreen ? 'selected' : ''}
            aria-pressed={fullscreen}
            title={fullscreen ? '退出全屏' : '全屏展示'}
            aria-label={fullscreen ? '退出全屏' : '全屏展示'}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Shrink size={15} /> : <Expand size={15} />}
            {fullscreen ? '退出' : '全屏'}
          </button>
        </div>
      )}
      {showRemoteTrack && remoteBitrateBps !== null && (
        <span className="remote-bitrate-badge">
          目标 {remoteBitrateBps / 1_000_000} Mbps
        </span>
      )}
    </section>
  );
}
