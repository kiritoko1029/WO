import type {
  IdentityRepository,
  SessionRepository,
} from '@wo/database';
import {
  adminOverviewSchema,
  type AdminOverview,
} from '@wo/protocol';

import type { RoomRegistry } from '../rooms/room-types.ts';
import type { SignalingConnection } from '../signaling/connection-registry.ts';

export class AdminServiceError extends Error {
  readonly code: 'FORBIDDEN' | 'USER_NOT_FOUND';

  constructor(code: 'FORBIDDEN' | 'USER_NOT_FOUND') {
    super(code === 'FORBIDDEN' ? 'Admin access required' : 'User not found');
    this.name = 'AdminServiceError';
    this.code = code;
  }
}

export interface AdminService {
  isSuperAdminEmail(email: string): boolean;
  assertSuperAdmin(userId: string): Promise<void>;
  getOverview(): Promise<AdminOverview>;
  setUserDisabled(
    actorUserId: string,
    targetUserId: string,
    disabled: boolean,
  ): Promise<void>;
}

export interface AdminRealtimeHandles {
  listConnections: () => readonly SignalingConnection[];
  roomRegistry: RoomRegistry | null;
}

export interface AdminServiceDependencies {
  readonly identityRepository: IdentityRepository;
  readonly sessionRepository: SessionRepository;
  readonly superAdminEmails: readonly string[];
  readonly realtime: AdminRealtimeHandles;
  readonly now?: () => Date;
}

export function createAdminService(
  dependencies: AdminServiceDependencies,
): AdminService {
  const now = dependencies.now ?? (() => new Date());
  const adminEmails = new Set(
    dependencies.superAdminEmails.map((email) => email.trim().toLowerCase()),
  );

  const isSuperAdminEmail = (email: string): boolean =>
    adminEmails.has(email.trim().toLowerCase());

  const assertSuperAdmin = async (userId: string): Promise<void> => {
    const identity =
      await dependencies.identityRepository.findEmailUserById(userId);
    if (
      identity === null ||
      identity.user.disabledAt !== null ||
      !isSuperAdminEmail(identity.emailNormalized)
    ) {
      throw new AdminServiceError('FORBIDDEN');
    }
  };

  return {
    isSuperAdminEmail,
    assertSuperAdmin,

    async getOverview() {
      const [users, sessions] = await Promise.all([
        dependencies.identityRepository.listEmailUsers(),
        dependencies.sessionRepository.listActiveSessionSummaries(),
      ]);
      const sessionsByUser = new Map(
        sessions.map((session) => [session.userId, session]),
      );
      const connections = dependencies.realtime.listConnections();
      const connectionsByUser = new Map<string, SignalingConnection[]>();
      for (const connection of connections) {
        const list = connectionsByUser.get(connection.identity.userId) ?? [];
        list.push(connection);
        connectionsByUser.set(connection.identity.userId, list);
      }
      const rooms = dependencies.realtime.roomRegistry?.listRooms() ?? [];

      const userSnapshots = users.map((user) => {
        const session = sessionsByUser.get(user.user.id);
        const userConnections = connectionsByUser.get(user.user.id) ?? [];
        return {
          userId: user.user.id,
          email: user.emailNormalized,
          displayName: user.user.displayName,
          verified: user.verifiedAt !== null,
          disabled: user.user.disabledAt !== null,
          isSuperAdmin: isSuperAdminEmail(user.emailNormalized),
          createdAt: user.user.createdAt.toISOString(),
          activeSessions: session?.activeSessionCount ?? 0,
          latestSessionAt: session?.latestSessionCreatedAt?.toISOString() ?? null,
          signalingConnections: userConnections.map((connection) => ({
            connectionId: connection.connectionId,
            userId: connection.identity.userId,
            email: user.emailNormalized,
            displayName: user.user.displayName,
            state: connection.state,
            roomId: connection.binding?.roomId ?? null,
            connectionEpoch: connection.binding?.connectionEpoch ?? null,
          })),
        };
      });

      let activeSessions = 0;
      for (const session of sessions) {
        activeSessions += session.activeSessionCount;
      }

      return adminOverviewSchema.parse({
        generatedAt: now().toISOString(),
        users: userSnapshots,
        rooms: rooms.map((room) => ({
          roomId: room.id,
          state: room.state,
          memberCount: room.members.length,
          onlineCount: room.members.filter((member) => member.online).length,
          hasScreenShare: room.screenLease !== null,
          roomCode: room.code,
        })),
        totals: {
          users: users.length,
          activeSessions,
          signalingConnections: connections.length,
          rooms: rooms.length,
        },
      });
    },

    async setUserDisabled(actorUserId, targetUserId, disabled) {
      await assertSuperAdmin(actorUserId);
      if (actorUserId === targetUserId && disabled) {
        throw new AdminServiceError('FORBIDDEN');
      }
      try {
        if (disabled) {
          await dependencies.identityRepository.disableUser(targetUserId);
          await dependencies.sessionRepository.revokeAllSessionsForUser(
            targetUserId,
          );
        } else {
          await dependencies.identityRepository.enableUser(targetUserId);
        }
      } catch {
        throw new AdminServiceError('USER_NOT_FOUND');
      }
    },
  };
}
