import { useRef, useState } from 'react';
import { AudioLines, Copy, ExternalLink, Settings, Share2 } from 'lucide-react';
import {
  createJoinProtocolUrl,
  createServerShareUrl,
  joinIntentSchema,
  serverJoinIntentSchema,
  type JoinIntent,
} from '@wo/protocol';

import { CallToolbar } from '../components/CallToolbar.js';
import { ConnectionStatus } from '../components/ConnectionStatus.js';
import { ParticipantSlots } from '../components/ParticipantSlots.js';
import { QualityPanel } from '../components/QualityPanel.js';
import { ScreenShareToolbar } from '../components/ScreenShareToolbar.js';
import { ScreenStage } from '../components/ScreenStage.js';
import { SourcePicker } from '../components/SourcePicker.js';
import { useCall } from '../state/call-store.js';
import { useRoom } from '../state/room-store.js';

export function RoomRoute({
  serverOrigin,
  joinIntent,
  onRoomClosed,
}: {
  readonly serverOrigin: string | null;
  readonly joinIntent?: JoinIntent | null;
  readonly onRoomClosed?: () => void | Promise<void>;
}) {
  const { room, busy, error, closeRoom } = useRoom();
  const call = useCall();
  const [hangingUp, setHangingUp] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState<'client' | 'web' | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const hangingUpRef = useRef(false);
  if (room === null) return null;
  const parsedShareIntent = serverJoinIntentSchema.safeParse({
    version: 1,
    mode: 'server',
    serverOrigin,
    roomCode: room.roomCode,
  });
  const providedShareIntent = joinIntentSchema.safeParse(joinIntent);
  const shareIntent =
    providedShareIntent.success &&
    providedShareIntent.data.roomCode === room.roomCode
      ? providedShareIntent.data
      : parsedShareIntent.success
        ? parsedShareIntent.data
        : null;
  const webShareUrl =
    shareIntent?.mode === 'server' ? createServerShareUrl(shareIntent) : null;
  const clientShareUrl =
    shareIntent === null ? null : createJoinProtocolUrl(shareIntent);
  const lanEndpoint =
    shareIntent?.mode === 'lan' ? new URL(shareIntent.endpoint).host : null;

  const screenState = call.snapshot.screenState;
  const screenActive =
    screenState === 'acquiring' ||
    screenState === 'picking' ||
    screenState === 'capturing' ||
    screenState === 'sharing';
  const self = room.participants.find((participant) => participant.isSelf);
  const remoteOwnsScreen =
    call.snapshot.screenOwner !== null &&
    call.snapshot.screenOwner.userId !== self?.userId;
  const remoteOwnerName = remoteOwnsScreen
    ? (call.snapshot.screenOwner?.displayName ?? null)
    : null;
  const screenPresentationLive =
    (remoteOwnsScreen && call.snapshot.remoteScreenTrack !== null) ||
    (screenState === 'sharing' && call.snapshot.localScreenTrack !== null);
  const pickerOpen =
    screenState === 'acquiring' ||
    screenState === 'picking' ||
    screenState === 'capturing';
  const visibleError =
    call.snapshot.error ??
    call.snapshot.screenError ??
    call.snapshot.screenBitrateError ??
    error;
  const canOpenScreenSettings =
    call.snapshot.screenPermission?.canOpenSettings === true &&
    (call.snapshot.screenPermission.status === 'denied' ||
      call.snapshot.screenPermission.status === 'restricted');

  const hangup = async (): Promise<void> => {
    if (hangingUpRef.current) return;
    hangingUpRef.current = true;
    setHangingUp(true);
    try {
      await call.controller.cleanup().catch(() => undefined);
      const closed = await closeRoom();
      if (closed || onRoomClosed !== undefined) await onRoomClosed?.();
    } finally {
      hangingUpRef.current = false;
      setHangingUp(false);
    }
  };
  const copyShareUrl = async (
    kind: 'client' | 'web',
    value: string,
  ): Promise<void> => {
    setCopyError(null);
    let succeeded = false;
    try {
      if (window.woClipboard !== undefined) {
        await window.woClipboard.writeText(value);
        succeeded = true;
      }
    } catch {
      succeeded = false;
    }
    try {
      if (!succeeded && navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(value);
        succeeded = true;
      }
    } catch {
      succeeded = false;
    }
    if (!succeeded && typeof document.execCommand === 'function') {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.readOnly = true;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      try {
        succeeded = document.execCommand('copy');
      } catch {
        succeeded = false;
      } finally {
        textarea.remove();
      }
    }
    if (succeeded) {
      setCopied(kind);
      return;
    }
    setCopied(null);
    setCopyError('复制失败，请允许剪贴板权限后重试');
  };

  return (
    <div className="room-shell">
      <header className="room-header">
        <div className="product-lockup compact">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={14} />
          </span>
          <span>WO</span>
        </div>
        <div className="room-identity">
          <ConnectionStatus status={call.snapshot.status} />
          <QualityPanel sample={call.snapshot.quality} />
          <span className="room-code-label">房间码</span>
          <code>{room.roomCode}</code>
          {lanEndpoint !== null && (
            <>
              <span className="room-code-label">可信局域网</span>
              <code className="lan-room-endpoint" title={lanEndpoint}>
                {lanEndpoint}
              </code>
            </>
          )}
          {shareIntent !== null && (
            <div className="room-share">
              <button
                type="button"
                className="icon-button"
                aria-label="分享房间"
                aria-expanded={shareOpen}
                onClick={() => {
                  setShareOpen((open) => !open);
                  setCopied(null);
                  setCopyError(null);
                }}
              >
                <Share2 size={16} />
              </button>
              {shareOpen && clientShareUrl !== null && (
                <div className="room-share-menu">
                  {webShareUrl !== null && (
                    <button
                      type="button"
                      onClick={() => void copyShareUrl('web', webShareUrl)}
                    >
                      <Copy size={15} />
                      {copied === 'web' ? '已复制网页链接' : '复制网页链接'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void copyShareUrl('client', clientShareUrl)}
                  >
                    <Copy size={15} />
                    {copied === 'client'
                      ? '已复制客户端链接'
                      : '复制客户端链接'}
                  </button>
                  {window.woShell === undefined && (
                    <a href={clientShareUrl}>
                      <ExternalLink size={15} />在 WO 客户端打开
                    </a>
                  )}
                  {shareIntent?.mode === 'lan' && (
                    <p className="lan-share-warning">
                      邀请包含访问密钥，仅发送给可信设备。
                    </p>
                  )}
                  {copyError !== null && (
                    <div className="room-share-error" role="alert">
                      {copyError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </header>
      <main
        className={`call-workspace${screenPresentationLive ? ' call-workspace--screen-live' : ''}`}
      >
        <ParticipantSlots
          participants={room.participants}
          muted={call.snapshot.muted}
        />
        <div className="room-error" role="alert" aria-live="polite">
          {visibleError !== null && <span>{visibleError}</span>}
          {canOpenScreenSettings && (
            <button
              type="button"
              onClick={() =>
                void call.controller.openScreenSettings().catch(() => undefined)
              }
            >
              <Settings size={14} />
              打开系统设置
            </button>
          )}
        </div>
        <ScreenStage
          localTrack={call.snapshot.localScreenTrack}
          remoteTrack={call.snapshot.remoteScreenTrack}
          localState={screenState}
          remoteOwnerName={remoteOwnerName}
          remoteBitrateBps={call.snapshot.remoteScreenBitrateBps}
          onPresentationVideo={call.controller.attachPresentationVideo}
        />
        {screenState === 'sharing' && (
          <ScreenShareToolbar
            settings={call.snapshot.screenCaptureSettings}
            target={call.snapshot.screenBitrateTarget}
            pending={call.snapshot.screenBitratePending}
            error={call.snapshot.screenBitrateError}
            quality={call.snapshot.quality}
            onTargetChange={(target) =>
              void call.controller
                .setScreenBitrate(target)
                .catch(() => undefined)
            }
          />
        )}
      </main>
      {pickerOpen && (
        <SourcePicker
          sources={call.snapshot.screenSources}
          selectedToken={call.snapshot.screenSelectedToken}
          state={screenState}
          onSelect={(token) =>
            void call.controller
              .selectScreenSource(token)
              .catch(() => undefined)
          }
          onStart={() => {
            void call.controller.startScreenShare().catch(() => undefined);
          }}
          onCancel={() =>
            void call.controller.stopScreenShare().catch(() => undefined)
          }
        />
      )}
      <CallToolbar
        busy={busy || hangingUp}
        muted={call.snapshot.muted}
        outputMuted={call.snapshot.outputMuted}
        inputs={call.snapshot.inputs}
        outputs={call.snapshot.outputs}
        selectedInputId={call.snapshot.selectedInputId}
        selectedOutputId={call.snapshot.selectedOutputId}
        supportsOutputSelection={call.snapshot.supportsOutputSelection}
        onMutedChange={call.controller.setMuted}
        onInputChange={(deviceId) =>
          void call.controller.switchMicrophone(deviceId).catch(() => undefined)
        }
        onOutputChange={(deviceId) =>
          void call.controller.selectOutput(deviceId).catch(() => undefined)
        }
        onOutputMutedChange={call.controller.setOutputMuted}
        onNoiseIntensityChange={(intensity) =>
          void call.controller.setNoiseIntensity(intensity).catch(() => undefined)
        }
        retryAvailable={call.snapshot.microphoneRetryAvailable}
        noiseIntensity={call.snapshot.noiseIntensity}
        screenState={screenState}
        screenDisabled={remoteOwnsScreen}
        screenOwnerName={remoteOwnerName}
        onScreenShare={() => {
          if (screenActive) {
            void call.controller.stopScreenShare().catch(() => undefined);
          } else {
            void call.controller.prepareScreenShare().catch(() => undefined);
          }
        }}
        onRetry={() => void call.controller.start().catch(() => undefined)}
        onHangup={() => void hangup()}
      />
    </div>
  );
}
