import { useEffect, useRef } from 'react';
import { Monitor, MonitorUp } from 'lucide-react';

import type { ScreenShareState } from '../media/screen-controller.js';

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const localSharing = localState === 'sharing';
  const showRemoteTrack = remoteOwnerName !== null && remoteTrack !== null;
  const showLocalTrack =
    !showRemoteTrack && localSharing && localTrack !== null;
  const presentationTrack = showRemoteTrack
    ? remoteTrack
    : showLocalTrack
      ? localTrack
      : null;

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

  return (
    <section className="screen-stage" aria-label="共享屏幕">
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
      {showRemoteTrack && remoteBitrateBps !== null && (
        <span className="remote-bitrate-badge">
          目标 {remoteBitrateBps / 1_000_000} Mbps
        </span>
      )}
    </section>
  );
}
