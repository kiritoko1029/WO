import type {
  AuthChangePasswordBody,
  AuthConfirmEmailChangeBody,
  AuthLoginBody,
  AuthRegisterBody,
  AuthRequestEmailChangeBody,
  AuthResendVerificationBody,
  AuthVerifyEmailBody,
  JoinIntent,
  PublicAuthUser,
  ServerJoinIntent,
  SignalTicketResponse,
} from '@wo/protocol';

import type { DesktopIpcEnvelope } from './ipc-envelope.js';

export interface PublicAuthSession {
  readonly user: PublicAuthUser;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
}

export type AuthRegisterResult =
  | Readonly<{ kind: 'session'; session: PublicAuthSession }>
  | Readonly<{ kind: 'verification_required'; email: string }>;

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

export type SystemAudioMode = 'loopback' | 'native-picker' | 'unsupported';

export interface ScreenPermissionSnapshot {
  readonly status: ScreenPermissionStatus;
  readonly canOpenSettings: boolean;
  readonly systemAudioMode: SystemAudioMode;
  readonly captureProcessElevated: boolean;
}

export interface DesktopApi {
  readonly auth: {
    register(input: AuthRegisterBody): Promise<AuthRegisterResult>;
    login(input: AuthLoginBody): Promise<PublicAuthSession>;
    verifyEmail(input: AuthVerifyEmailBody): Promise<PublicAuthSession>;
    resendVerification(
      input: AuthResendVerificationBody,
    ): Promise<Readonly<{ email: string }>>;
    changePassword(input: AuthChangePasswordBody): Promise<void>;
    requestEmailChange(
      input: AuthRequestEmailChangeBody,
    ): Promise<Readonly<{ email: string }>>;
    confirmEmailChange(
      input: AuthConfirmEmailChangeBody,
    ): Promise<PublicAuthSession>;
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
    subscribeStopRequested?(listener: () => void | Promise<void>): () => void;
  };
}

export interface DesktopBridge {
  readonly auth: {
    register(
      input: AuthRegisterBody,
    ): Promise<DesktopIpcEnvelope<AuthRegisterResult>>;
    login(input: AuthLoginBody): Promise<DesktopIpcEnvelope<PublicAuthSession>>;
    verifyEmail(
      input: AuthVerifyEmailBody,
    ): Promise<DesktopIpcEnvelope<PublicAuthSession>>;
    resendVerification(
      input: AuthResendVerificationBody,
    ): Promise<DesktopIpcEnvelope<Readonly<{ email: string }>>>;
    changePassword(
      input: AuthChangePasswordBody,
    ): Promise<DesktopIpcEnvelope<null>>;
    requestEmailChange(
      input: AuthRequestEmailChangeBody,
    ): Promise<DesktopIpcEnvelope<Readonly<{ email: string }>>>;
    confirmEmailChange(
      input: AuthConfirmEmailChangeBody,
    ): Promise<DesktopIpcEnvelope<PublicAuthSession>>;
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
    subscribeStopRequested(listener: () => void | Promise<void>): () => void;
  };
}

export type BackendTargetSource = 'environment' | 'stored' | 'default';

export interface BackendTargetSnapshot {
  readonly origin: string;
  readonly source: BackendTargetSource;
  readonly readOnly: boolean;
}

export interface DesktopShellApi {
  readonly backendTarget: {
    get(): Promise<BackendTargetSnapshot>;
    save(origin: string): Promise<void>;
  };
  readonly joinIntent: {
    consume(): Promise<JoinIntent | null>;
    switchServer(intent: ServerJoinIntent): Promise<void>;
    subscribe(listener: () => void): () => void;
  };
}

export interface DesktopShellBridge {
  readonly backendTarget: {
    get(): Promise<DesktopIpcEnvelope<BackendTargetSnapshot>>;
    save(origin: string): Promise<DesktopIpcEnvelope<null>>;
  };
  readonly joinIntent: {
    consume(): Promise<DesktopIpcEnvelope<JoinIntent | null>>;
    switchServer(intent: ServerJoinIntent): Promise<DesktopIpcEnvelope<null>>;
    subscribe(listener: () => void): () => void;
  };
}
