import type {
  DesktopApi,
  DesktopShellBridge,
  PublicAuthSession,
} from '../../desktop/src/preload/types.js';
import type {
  CallController,
  CallSnapshot,
} from '../../desktop/src/renderer/src/state/call-store.js';
import type {
  RoomGateway,
  RoomSnapshot,
} from '../../desktop/src/renderer/src/state/room-store.js';

// Local presentation data only. No accounts, network, microphone or desktop
// capture are used; this module is not a production build entry.
export const demoSession: PublicAuthSession = {
  user: {
    userId:
      '00000000-0000-4000-8000-000000000001' as PublicAuthSession['user']['userId'],
    email: 'hello@example.com',
    displayName: '小禾',
  },
  accessToken: 'local-preview-only',
  accessTokenExpiresAt: Date.now() + 3_600_000,
};

export const demoRoom: RoomSnapshot = {
  roomId: 'local-preview-room',
  roomCode: '482731',
  role: 'creator',
  connectionStatus: 'connected',
  participants: [
    {
      userId: demoSession.user.userId,
      displayName: '小禾',
      isSelf: true,
      online: true,
    },
    {
      userId: '00000000-0000-4000-8000-000000000002',
      displayName: '林间',
      isSelf: false,
      online: true,
    },
  ],
};

export const demoShell: DesktopShellBridge = {
  backendTarget: {
    get: async () => ({
      ok: true,
      value: {
        origin: 'https://wo.example.com',
        source: 'stored',
        readOnly: false,
      },
    }),
    save: async () => {
      throw new Error('Local preview does not change servers');
    },
  },
  joinIntent: {
    consume: async () => ({ ok: true, value: null }),
    switchServer: async () => {
      throw new Error('Local preview does not change servers');
    },
    subscribe: () => () => undefined,
  },
  openExternal: async () => ({ ok: true, value: null }),
};

export function createPreviewDesktop(anonymous: boolean): DesktopApi {
  return {
    auth: {
      register: async () => ({ kind: 'session', session: demoSession }),
      login: async () => demoSession,
      verifyEmail: async () => demoSession,
      resendVerification: async () => ({ email: demoSession.user.email }),
      changePassword: async () => undefined,
      requestEmailChange: async () => ({ email: demoSession.user.email }),
      confirmEmailChange: async () => demoSession,
      refresh: async () => {
        if (anonymous)
          throw Object.assign(new Error('Sign in'), { code: 'AUTH_REQUIRED' });
        return demoSession;
      },
      logout: async () => undefined,
    },
    realtime: {
      issueTicket: async () => {
        throw new Error('No network in preview');
      },
    },
    capture: {
      list: async () => [],
      select: async () => undefined,
      permission: async () => ({
        status: 'granted',
        canOpenSettings: false,
        systemAudioMode: 'loopback',
        captureProcessElevated: false,
      }),
      openSettings: async () => undefined,
    },
  };
}

export const demoGateway: RoomGateway = {
  createRoom: async () => demoRoom,
  joinRoom: async () => demoRoom,
  leaveRoom: async () => undefined,
  endRoom: async () => undefined,
  subscribe: () => () => undefined,
};

export function createPreviewCall(): CallController {
  let snapshot: CallSnapshot = {
    status: 'connected',
    error: null,
    muted: false,
    outputMuted: false,
    remoteVolume: 1,
    microphoneVolume: 1,
    inputs: [{ deviceId: 'default', label: '默认麦克风' }],
    outputs: [{ deviceId: 'default', label: '默认扬声器' }],
    selectedInputId: 'default',
    selectedOutputId: 'default',
    supportsOutputSelection: true,
    microphoneRetryAvailable: false,
    noiseIntensity: 'off',
    rnnoiseActive: false,
    screenState: 'idle',
    screenSources: [],
    screenSelectedToken: null,
    screenSystemAudioEnabled: false,
    screenCaptureSettings: null,
    screenError: null,
    screenPermissionError: false,
    screenOwner: null,
    screenOwnerLeaseId: null,
    localScreenTrack: null,
    remoteScreenTrack: null,
    screenBitrateTarget: { mode: 'fixed', bitrateBps: 10_000_000 },
    screenBitratePending: null,
    screenBitrateError: null,
    remoteScreenBitrateBps: null,
    screenPermission: {
      status: 'granted',
      canOpenSettings: false,
      systemAudioMode: 'loopback',
      captureProcessElevated: false,
    },
    quality: null,
    localAudioLevel: 0,
    remoteAudioLevel: 0,
  };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CallSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: async () => undefined,
    setMuted: (muted) => update({ muted }),
    setOutputMuted: (outputMuted) => update({ outputMuted }),
    setRemoteVolume: (remoteVolume) => update({ remoteVolume }),
    setMicrophoneVolume: (microphoneVolume) => update({ microphoneVolume }),
    switchMicrophone: async (selectedInputId) => update({ selectedInputId }),
    selectOutput: async (selectedOutputId) => update({ selectedOutputId }),
    setNoiseIntensity: async (noiseIntensity) => update({ noiseIntensity }),
    refreshDevices: async () => undefined,
    prepareScreenShare: async () => update({ screenState: 'picking' }),
    selectScreenSource: async (screenSelectedToken) =>
      update({ screenSelectedToken }),
    setScreenSystemAudioEnabled: (screenSystemAudioEnabled) =>
      update({ screenSystemAudioEnabled }),
    refreshScreenSources: async () => undefined,
    startScreenShare: async () => undefined,
    stopScreenShare: async () => update({ screenState: 'idle' }),
    setScreenBitrate: async (screenBitrateTarget) =>
      update({ screenBitrateTarget }),
    openScreenSettings: async () => undefined,
    attachPresentationVideo: () => undefined,
    exportDiagnostics: () => ({ version: 1, samples: [] }),
    cleanup: async () => undefined,
  };
}
