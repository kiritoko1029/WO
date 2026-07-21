import type {
  DesktopLanApi,
  LanSessionSnapshot,
} from '../../../preload/lan-types.js';
import type { DesktopApi, PublicAuthSession } from '../../../preload/types.js';

function sessionOf(session: LanSessionSnapshot): PublicAuthSession {
  return Object.freeze({
    user: session.user,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
  });
}

export function createLanDesktopApi(
  lan: DesktopLanApi,
  session: LanSessionSnapshot,
  capture: DesktopApi['capture'],
): Readonly<DesktopApi> {
  const current = sessionOf(session);
  const unavailable = () =>
    Promise.reject(
      Object.assign(new Error('Accounts are unavailable in LAN mode'), {
        code: 'INVALID_STATE',
      }),
    );
  return Object.freeze({
    auth: Object.freeze({
      register: unavailable,
      login: unavailable,
      refresh: async () => current,
      logout: () => lan.stop(),
      verifyEmail: async () => {
        throw new Error('LAN mode does not support account email verification');
      },
      resendVerification: async () => {
        throw new Error('LAN mode does not support account email verification');
      },
      changePassword: async () => {
        throw new Error('LAN mode does not support password changes');
      },
      requestEmailChange: async () => {
        throw new Error('LAN mode does not support email changes');
      },
      confirmEmailChange: async () => {
        throw new Error('LAN mode does not support email changes');
      },
    }),
    realtime: Object.freeze({
      issueTicket: (accessToken: string) => {
        if (accessToken !== current.accessToken) {
          return Promise.reject(
            Object.assign(new Error('Invalid LAN session'), {
              code: 'AUTH_REQUIRED',
            }),
          );
        }
        return lan.issueTicket();
      },
    }),
    capture,
  });
}
