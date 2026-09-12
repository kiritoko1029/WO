import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import {
  AdminServiceError,
  type AdminService,
} from '../src/modules/admin/admin-service.ts';
import { createDeploymentStatusReader } from '../src/modules/admin/deployment-status.ts';
import { createAccessTokenService } from '../src/modules/auth/access-token.ts';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

describe('admin deployment authorization', () => {
  test('requires a valid token and current admin permission before reading any status', async () => {
    let disabled = false;
    const accessTokenService = createAccessTokenService({
      jwtAccessSecret: Buffer.alloc(32, 7).toString('base64url'),
      issuer: 'https://wo.example.com',
    });
    const adminService: AdminService = {
      isSuperAdminEmail: (email) => email === 'admin@example.com',
      assertSuperAdmin: async (id) => {
        if (id !== ADMIN_ID || disabled)
          throw new AdminServiceError('FORBIDDEN');
      },
      getOverview: async () => {
        throw new Error('Unused');
      },
      setUserDisabled: async () => undefined,
    };
    const read = vi.fn(
      createDeploymentStatusReader({
        publicUrl: 'https://wo.example.com',
        turn: {
          host: 'wo.example.com',
          urls: [],
          realm: 'wo',
          sharedSecret: 'SECRET_SENTINEL',
          credentialTtlSeconds: 600,
        },
        email: {
          domainAllowlist: [],
          superAdminEmails: [],
          verificationRequired: false,
          codeTtlSeconds: 600,
          smtp: null,
        },
      }),
    );
    const app = await createApp({
      authService: {} as never,
      accessTokenService,
      readinessCheck: async () => undefined,
      logger: false,
      admin: { adminService, deploymentStatus: read },
    });
    try {
      const member = await accessTokenService.sign({
        userId: MEMBER_ID,
        sessionId: SESSION_ID,
      });
      const admin = await accessTokenService.sign({
        userId: ADMIN_ID,
        sessionId: SESSION_ID,
      });
      for (const authorization of [undefined, 'Bearer invalid']) {
        expect(
          (
            await app.inject({
              method: 'GET',
              url: '/v1/admin/deployment',
              headers: authorization === undefined ? {} : { authorization },
            })
          ).statusCode,
        ).toBe(401);
      }
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/admin/deployment',
            headers: { authorization: `Bearer ${member}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(read).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/admin/deployment',
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().enabled).toBe(false);
      expect(response.body).not.toContain('SECRET_SENTINEL');
      expect(read).toHaveBeenCalledTimes(1);
      disabled = true;
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/admin/deployment',
            headers: { authorization: `Bearer ${admin}` },
          })
        ).statusCode,
      ).toBe(403);
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/admin/deployment',
            headers: { authorization: `Bearer ${admin}` },
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
