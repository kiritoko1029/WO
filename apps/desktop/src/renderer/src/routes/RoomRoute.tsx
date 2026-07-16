import { useRef, useState } from 'react';
import { AudioLines, Monitor } from 'lucide-react';

import { CallToolbar } from '../components/CallToolbar.js';
import { ConnectionStatus } from '../components/ConnectionStatus.js';
import { ParticipantSlots } from '../components/ParticipantSlots.js';
import { useCall } from '../state/call-store.js';
import { useRoom } from '../state/room-store.js';

export function RoomRoute() {
  const { room, busy, error, closeRoom } = useRoom();
  const call = useCall();
  const [hangingUp, setHangingUp] = useState(false);
  const hangingUpRef = useRef(false);
  if (room === null) return null;

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
          {call.snapshot.error ?? error}
        </div>
        <section className="screen-stage" aria-label="共享屏幕">
          <div className="screen-empty">
            <Monitor size={42} strokeWidth={1.4} />
            <h2>等待屏幕共享</h2>
          </div>
        </section>
      </main>
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
        onRetry={() => void call.controller.start().catch(() => undefined)}
        onHangup={() => void hangup()}
      />
    </div>
  );
}
