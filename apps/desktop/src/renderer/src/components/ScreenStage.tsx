import { useEffect, useRef, useState } from 'react';
import {
  Expand,
  Maximize2,
  Minimize2,
  Monitor,
  MonitorUp,
  Shrink,
} from 'lucide-react';

import type { ScreenShareState } from '../media/screen-controller.js';

export type ScreenViewMode = 'fit' | 'fill';

function isFullscreenElement(element: HTMLElement | null): boolean {
  if (element === null) return false;
  const doc = element.ownerDocument;
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
  const [viewMode, setViewMode] = useState<ScreenViewMode>('fit');
  const [fullscreen, setFullscreen] = useState(false);
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

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const syncFullscreen = (): void => {
      setFullscreen(isFullscreenElement(stage));
    };
    stage.ownerDocument.addEventListener('fullscreenchange', syncFullscreen);
    syncFullscreen();
    return () => {
      stage.ownerDocument.removeEventListener(
        'fullscreenchange',
        syncFullscreen,
      );
    };
  }, [live]);

  useEffect(() => {
    if (live) return;
    setViewMode('fit');
    const stage = stageRef.current;
    if (stage !== null && isFullscreenElement(stage)) {
      void stage.ownerDocument.exitFullscreen().catch(() => undefined);
    }
  }, [live]);

  const toggleFullscreen = (): void => {
    const stage = stageRef.current;
    if (stage === null) return;
    if (isFullscreenElement(stage)) {
      void stage.ownerDocument.exitFullscreen().catch(() => undefined);
      return;
    }
    void stage.requestFullscreen().catch(() => undefined);
  };

  return (
    <section
      ref={stageRef}
      className={`screen-stage${live ? ' screen-stage--live' : ''}${fullscreen ? ' screen-stage--fullscreen' : ''}`}
      aria-label="共享屏幕"
      data-view-mode={viewMode}
    >
      {presentationTrack !== null && (
        <video
          ref={videoRef}
          className={`remote-screen-video remote-screen-video--${viewMode}`}
          aria-label={
            showRemoteTrack
              ? `${remoteOwnerName ?? '对方'}的共享屏幕`
              : '本地共享预览'
          }
          autoPlay
          muted={showLocalTrack}
          playsInline
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
          <button
            type="button"
            className={viewMode === 'fit' ? 'selected' : ''}
            aria-pressed={viewMode === 'fit'}
            title="适应窗口"
            aria-label="适应窗口"
            onClick={() => setViewMode('fit')}
          >
            <Minimize2 size={15} />
            适应
          </button>
          <button
            type="button"
            className={viewMode === 'fill' ? 'selected' : ''}
            aria-pressed={viewMode === 'fill'}
            title="铺满放大"
            aria-label="铺满放大"
            onClick={() => setViewMode('fill')}
          >
            <Maximize2 size={15} />
            放大
          </button>
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
