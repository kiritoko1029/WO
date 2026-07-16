import { useRef, useState } from 'react';
import { AudioLines, Settings } from 'lucide-react';

import { CallToolbar } from '../components/CallToolbar.js';
import { ConnectionStatus } from '../components/ConnectionStatus.js';
import { ParticipantSlots } from '../components/ParticipantSlots.js';
import { QualityPanel } from '../components/QualityPanel.js';
import { ScreenShareToolbar } from '../components/ScreenShareToolbar.js';
import { ScreenStage } from '../components/ScreenStage.js';
import { SourcePicker } from '../components/SourcePicker.js';
import { useCall } from '../state/call-store.js';
import { useRoom } from '../state/room-store.js';

export function RoomRoute() {
  const { room, busy, error, closeRoom } = useRoom();
  const call = useCall();
  const [hangingUp, setHangingUp] = useState(false);
  const hangingUpRef = useRef(false);
  if (room === null) return null;

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
      await closeRoom();
    } finally {
      hangingUpRef.current = false;
      setHangingUp(false);
    }
  };

  return (
    <div className="room-shell">
      <header className="room-header">
        <div className="product-lockup compact">
          <span className="product-mark" aria-hidden="true">
            <AudioLines size={19} />
          </span>
          <span>WO</span>
        </div>
        <div className="room-identity">
          <ConnectionStatus status={call.snapshot.status} />
          <QualityPanel sample={call.snapshot.quality} />
          <span className="room-code-label">房间码</span>
          <code>{room.roomCode}</code>
        </div>
      </header>
      <main className="call-workspace">
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
        retryAvailable={call.snapshot.microphoneRetryAvailable}
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
