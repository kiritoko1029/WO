import { describe, expect, test } from 'vitest';

import {
  createAdminService,
  AdminServiceError,
} from '../src/modules/admin/admin-service.ts';

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_USER_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-07-20T12:00:00.000Z');

function createRepositories() {
  const users = new Map([
    [
      ADMIN_USER_ID,
      {
        emailNormalized: 'admin@example.com',
        verifiedAt: NOW,
        user: {
          id: ADMIN_USER_ID,
          displayName: 'Admin',
          createdAt: NOW,
          disabledAt: null as Date | null,
        },
      },
    ],
    [
      MEMBER_USER_ID,
      {
        emailNormalized: 'member@example.com',
        verifiedAt: null as Date | null,
        user: {
          id: MEMBER_USER_ID,
          displayName: 'Member',
          createdAt: NOW,
          disabledAt: null as Date | null,
        },
      },
    ],
  ]);

  const identityRepository = {
    async findEmailUserById(userId: string) {
      return users.get(userId) ?? null;
    },
    async listEmailUsers() {
      return [...users.values()];
    },
    async disableUser(userId: string) {
      const record = users.get(userId);
      if (!record) throw new Error('USER_NOT_FOUND');
      const next = {
        ...record,
        user: { ...record.user, disabledAt: NOW },
      };
      users.set(userId, next);
      return next.user;
    },
    async enableUser(userId: string) {
      const record = users.get(userId);
      if (!record) throw new Error('USER_NOT_FOUND');
      const next = {
        ...record,
        user: { ...record.user, disabledAt: null },
      };
      users.set(userId, next);
      return next.user;
    },
  };

  const sessionRepository = {
    async listActiveSessionSummaries() {
      return [
        {
          userId: ADMIN_USER_ID,
          activeSessionCount: 2,
          latestSessionCreatedAt: NOW,
          latestSessionExpiresAt: NOW,
        },
      ];
    },
    async revokeAllSessionsForUser() {
      return 1;
    },
  };

  return { identityRepository, sessionRepository, users };
}

describe('createAdminService', () => {
  test('builds overview with users, rooms, and live connections', async () => {
    const { identityRepository, sessionRepository } = createRepositories();
    const service = createAdminService({
      identityRepository: identityRepository as never,
      sessionRepository: sessionRepository as never,
      superAdminEmails: ['admin@example.com'],
      now: () => NOW,
      realtime: {
        listConnections: () =>
          [
            {
              connectionId: 'conn-1',
              identity: { userId: MEMBER_USER_ID },
              state: 'active',
              binding: {
                roomId: '33333333-3333-4333-8333-333333333333',
                connectionEpoch: 1,
              },
            },
          ] as never,
        roomRegistry: {
          listRooms: () =>
            [
              {
                id: '33333333-3333-4333-8333-333333333333',
                state: 'connected',
                members: [{ online: true }, { online: false }],
                screenLease: null,
                code: '123456',
              },
            ] as never,
        } as never,
      },
    });

    await service.assertSuperAdmin(ADMIN_USER_ID);
    await expect(
      service.assertSuperAdmin(MEMBER_USER_ID),
    ).rejects.toBeInstanceOf(AdminServiceError);

    const overview = await service.getOverview();
    expect(overview.totals).toEqual({
      users: 2,
      activeSessions: 2,
      signalingConnections: 1,
      rooms: 1,
    });
    expect(
      overview.users.find((user) => user.userId === ADMIN_USER_ID),
    ).toMatchObject({
      isSuperAdmin: true,
      activeSessions: 2,
      verified: true,
    });
    const member = overview.users.find(
      (user) => user.userId === MEMBER_USER_ID,
    );
    expect(member?.signalingConnections).toHaveLength(1);
    expect(member?.signalingConnections[0]?.state).toBe('active');
    expect(overview.rooms[0]).toMatchObject({
      memberCount: 2,
      onlineCount: 1,
      roomCode: '123456',
    });
  });

  test('disables a non-admin user and revokes sessions', async () => {
    const { identityRepository, sessionRepository, users } =
      createRepositories();
    let revoked = 0;
    const service = createAdminService({
      identityRepository: identityRepository as never,
      sessionRepository: {
        ...sessionRepository,
        async revokeAllSessionsForUser() {
          revoked += 1;
          return 1;
        },
      } as never,
      superAdminEmails: ['admin@example.com'],
      now: () => NOW,
      realtime: {
        listConnections: () => [],
        roomRegistry: null,
      },
    });

    await service.setUserDisabled(ADMIN_USER_ID, MEMBER_USER_ID, true);
    expect(users.get(MEMBER_USER_ID)?.user.disabledAt).toEqual(NOW);
    expect(revoked).toBe(1);

    await service.setUserDisabled(ADMIN_USER_ID, MEMBER_USER_ID, false);
    expect(users.get(MEMBER_USER_ID)?.user.disabledAt).toBeNull();

    await expect(
      service.setUserDisabled(ADMIN_USER_ID, ADMIN_USER_ID, true),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
