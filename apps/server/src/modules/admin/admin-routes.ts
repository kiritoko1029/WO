import type { FastifyInstance } from 'fastify';
import { adminDisableUserBodySchema, userIdSchema } from '@wo/protocol';
import { z } from 'zod';

import { HttpError } from '../../http/errors.ts';
import { AdminServiceError, type AdminService } from './admin-service.ts';

export interface AdminRouteDependencies {
  readonly adminService: AdminService;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminRouteDependencies,
): void {
  const requireAdmin = async (request: {
    authIdentity: { userId: string } | null;
  }): Promise<string> => {
    if (request.authIdentity === null) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    try {
      await dependencies.adminService.assertSuperAdmin(
        request.authIdentity.userId,
      );
    } catch (error) {
      if (error instanceof AdminServiceError && error.code === 'FORBIDDEN') {
        throw new HttpError(403, 'INVALID_STATE', 'Admin access required');
      }
      throw error;
    }
    return request.authIdentity.userId;
  };

  app.get(
    '/v1/admin/overview',
    { preHandler: app.authenticate },
    async (request) => {
      await requireAdmin(request);
      return dependencies.adminService.getOverview();
    },
  );

  app.get('/v1/admin/me', { preHandler: app.authenticate }, async (request) => {
    if (request.authIdentity === null) {
      throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication is required');
    }
    try {
      await dependencies.adminService.assertSuperAdmin(
        request.authIdentity.userId,
      );
      return { admin: true as const };
    } catch {
      return { admin: false as const };
    }
  });

  app.post(
    '/v1/admin/users/:userId/disabled',
    { preHandler: app.authenticate },
    async (request) => {
      const actorUserId = await requireAdmin(request);
      const params = z
        .object({ userId: userIdSchema })
        .strict()
        .parse(request.params);
      const body = adminDisableUserBodySchema.parse(request.body);
      try {
        await dependencies.adminService.setUserDisabled(
          actorUserId,
          params.userId,
          body.disabled,
        );
      } catch (error) {
        if (error instanceof AdminServiceError) {
          if (error.code === 'FORBIDDEN') {
            throw new HttpError(403, 'INVALID_STATE', error.message);
          }
          throw new HttpError(404, 'INVALID_STATE', error.message);
        }
        throw error;
      }
      return {
        ok: true as const,
        userId: params.userId,
        disabled: body.disabled,
      };
    },
  );
}
