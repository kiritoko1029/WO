import { useEffect, useRef } from 'react';
import { Monitor, MonitorUp } from 'lucide-react';

import type { ScreenShareState } from '../media/screen-controller.js';

export function ScreenStage({
  remoteTrack,
  localState,
  remoteOwnerName,
  remoteBitrateBps,
  onPresentationVideo,
}: {
  readonly remoteTrack: MediaStreamTrack | null;
  readonly localState: ScreenShareState;
  readonly remoteOwnerName: string | null;
  readonly remoteBitrateBps: number | null;
  readonly onPresentationVideo?: (video: HTMLVideoElement | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (
      remoteTrack === null ||
      remoteOwnerName === null ||
      typeof MediaStream === 'undefined'
    ) {
      video.srcObject = null;
      return;
    }
    video.srcObject = new MediaStream([remoteTrack]);
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [remoteOwnerName, remoteTrack]);

  const localSharing = localState === 'sharing';
  const waitingForRemoteTrack =
    remoteOwnerName !== null && remoteTrack === null;
  const showRemoteTrack = remoteOwnerName !== null && remoteTrack !== null;

  useEffect(() => {
    const video = showRemoteTrack ? videoRef.current : null;
    onPresentationVideo?.(video);
    return () => onPresentationVideo?.(null);
  }, [onPresentationVideo, showRemoteTrack]);

  return (
    <section className="screen-stage" aria-label="共享屏幕">
      {showRemoteTrack && (
        <video
          ref={videoRef}
          className="remote-screen-video"
          aria-label={`${remoteOwnerName ?? '对方'}的共享屏幕`}
          autoPlay
          playsInline
        />
      )}
      {!showRemoteTrack && (
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
