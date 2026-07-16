import type {
  AuthLoginBody,
  AuthRegisterBody,
  PublicAuthUser,
  SignalTicketResponse,
} from '@wo/protocol';

import type { DesktopIpcEnvelope } from './ipc-envelope.js';

export interface PublicAuthSession {
  readonly user: PublicAuthUser;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
}

export interface RealtimeConnectionGrant extends SignalTicketResponse {
  readonly endpoint: string;
}

export interface CaptureSourceSummary {
  readonly token: string;
  readonly name: string;
  readonly kind: 'screen' | 'window';
  readonly thumbnailDataUrl: string;
}

export type ScreenPermissionStatus =
  'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface ScreenPermissionSnapshot {
  readonly status: ScreenPermissionStatus;
  readonly canOpenSettings: boolean;
}

export interface DesktopApi {
  readonly auth: {
    register(input: AuthRegisterBody): Promise<PublicAuthSession>;
    login(input: AuthLoginBody): Promise<PublicAuthSession>;
    refresh(): Promise<PublicAuthSession>;
    logout(): Promise<void>;
  };
  readonly realtime: {
    issueTicket(accessToken: string): Promise<RealtimeConnectionGrant>;
  };
  readonly capture: {
    list(): Promise<readonly CaptureSourceSummary[]>;
    select(token: string): Promise<void>;
    permission(): Promise<ScreenPermissionSnapshot>;
    openSettings(): Promise<void>;
  };
}

export interface DesktopBridge {
  readonly auth: {
    register(
      input: AuthRegisterBody,
    ): Promise<DesktopIpcEnvelope<PublicAuthSession>>;
    login(input: AuthLoginBody): Promise<DesktopIpcEnvelope<PublicAuthSession>>;
    refresh(): Promise<DesktopIpcEnvelope<PublicAuthSession>>;
    logout(): Promise<DesktopIpcEnvelope<null>>;
  };
  readonly realtime: {
    issueTicket(
      accessToken: string,
    ): Promise<DesktopIpcEnvelope<RealtimeConnectionGrant>>;
  };
  readonly capture: {
    list(): Promise<DesktopIpcEnvelope<readonly CaptureSourceSummary[]>>;
    select(token: string): Promise<DesktopIpcEnvelope<null>>;
    permission(): Promise<DesktopIpcEnvelope<ScreenPermissionSnapshot>>;
    openSettings(): Promise<DesktopIpcEnvelope<null>>;
  };
}
