import { Mic, MicOff, UserRound } from 'lucide-react';

import type { RoomParticipant } from '../state/room-store.js';

export function ParticipantSlots({
  participants,
  muted,
}: {
  readonly participants: readonly RoomParticipant[];
  readonly muted: boolean;
}) {
  return (
    <div className="participant-slots" aria-label="参与者">
      {[0, 1].map((index) => {
        const participant = participants[index];
        return (
          <div
            className={`participant-slot${participant ? '' : ' empty'}`}
            data-testid="participant-slot"
            key={index}
          >
            <span className="participant-avatar" aria-hidden="true">
              <UserRound size={19} />
            </span>
            <span className="participant-name">
              {participant
                ? `${participant.displayName}${participant.isSelf ? '（我）' : ''}`
                : '等待加入'}
            </span>
            {participant && (
              <span
                className={`participant-state${participant.online ? '' : ' offline'}`}
                title={participant.online ? '在线' : '离线'}
              >
                {participant.isSelf && muted ? (
                  <MicOff size={15} />
                ) : (
                  <Mic size={15} />
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
