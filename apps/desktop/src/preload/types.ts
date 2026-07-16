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
}
