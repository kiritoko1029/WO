import { Mic, MicOff } from 'lucide-react';

import type { RoomParticipant } from '../state/room-store.js';

function initialFor(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  return trimmed.slice(0, 1).toUpperCase();
}

export function ParticipantSlots({
  participants,
  muted,
}: {
  readonly participants: readonly RoomParticipant[];
  readonly muted: boolean;
}) {
  const ordered = [...participants].sort((left, right) => {
    if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
    return left.displayName.localeCompare(right.displayName, 'zh-CN');
  });

  return (
    <div className="participant-float-bar" aria-label="参与者">
      {ordered.map((participant) => {
        const label = `${participant.displayName}${participant.isSelf ? '（我）' : ''}`;
        return (
          <div
            className={`participant-chip${participant.online ? '' : ' offline'}${participant.isSelf ? ' self' : ''}`}
            data-testid="participant-slot"
            key={participant.userId}
            title={label}
          >
            <span className="participant-chip-avatar" aria-hidden="true">
              {initialFor(participant.displayName)}
            </span>
            <span className="participant-chip-name">{label}</span>
            <span
              className={`participant-chip-state${participant.online ? '' : ' offline'}`}
              title={participant.online ? '在线' : '离线'}
            >
              {participant.isSelf && muted ? (
                <MicOff size={13} />
              ) : (
                <Mic size={13} />
              )}
            </span>
          </div>
        );
      })}
      {ordered.length === 1 && (
        <div className="participant-chip waiting" data-testid="participant-waiting">
          <span className="participant-chip-name">等待加入…</span>
        </div>
      )}
    </div>
  );
}
