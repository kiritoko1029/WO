import type { LanJoinIntent, PublicAuthUser } from '@wo/protocol';

import type { DesktopIpcEnvelope } from './ipc-envelope.js';
import type { RealtimeConnectionGrant } from './types.js';

export interface LanSessionSnapshot {
  readonly role: 'host' | 'guest';
  readonly user: PublicAuthUser;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly joinIntent: LanJoinIntent;
}

export type LanSocketEvent =
  | { readonly type: 'open' }
  | { readonly type: 'message'; readonly data: string }
  | { readonly type: 'error' }
  | {
      readonly type: 'close';
      readonly code: number;
      readonly reason: string;
    };

export interface DesktopLanBridge {
  host(displayName: string): Promise<DesktopIpcEnvelope<LanSessionSnapshot>>;
  join(
    displayName: string,
    intent: LanJoinIntent,
  ): Promise<DesktopIpcEnvelope<LanSessionSnapshot>>;
  parseInvite(value: string): Promise<DesktopIpcEnvelope<LanJoinIntent>>;
  issueTicket(): Promise<DesktopIpcEnvelope<RealtimeConnectionGrant>>;
  stop(): Promise<DesktopIpcEnvelope<null>>;
  readonly socket: {
    open(
      endpoint: string,
      protocols: readonly string[],
    ): Promise<DesktopIpcEnvelope<null>>;
    send(data: string): Promise<DesktopIpcEnvelope<null>>;
    close(): Promise<DesktopIpcEnvelope<null>>;
    subscribe(listener: (event: LanSocketEvent) => void): () => void;
  };
}

export interface DesktopLanApi {
  host(displayName: string): Promise<LanSessionSnapshot>;
  join(displayName: string, intent: LanJoinIntent): Promise<LanSessionSnapshot>;
  parseInvite(value: string): Promise<LanJoinIntent>;
  issueTicket(): Promise<RealtimeConnectionGrant>;
  stop(): Promise<void>;
  readonly socket: {
    open(endpoint: string, protocols: readonly string[]): Promise<void>;
    send(data: string): Promise<void>;
    close(): Promise<void>;
    subscribe(listener: (event: LanSocketEvent) => void): () => void;
  };
}
