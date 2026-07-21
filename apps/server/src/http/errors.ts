import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { AuthServiceError } from '../modules/auth/auth-service.ts';
import { safeErrorMetadata } from '../logging.ts';
import { HttpError } from './http-error.ts';

export { HttpError, type HttpErrorCode } from './http-error.ts';

interface StatusError {
  readonly statusCode?: unknown;
  readonly code?: unknown;
  readonly name?: unknown;
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const statusCode = (error as StatusError).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof AuthServiceError) {
    switch (error.code) {
      case 'EMAIL_ALREADY_REGISTERED':
        return new HttpError(409, 'INVALID_STATE', error.message);
      case 'EMAIL_DOMAIN_NOT_ALLOWED':
        return new HttpError(403, 'INVALID_STATE', error.message);
      case 'EMAIL_NOT_VERIFIED':
        return new HttpError(403, 'INVALID_STATE', error.message);
      case 'INVALID_VERIFICATION_CODE':
        return new HttpError(400, 'VALIDATION_ERROR', error.message);
      case 'SERVICE_UNAVAILABLE':
        return new HttpError(503, 'SERVICE_UNAVAILABLE', error.message);
      case 'INVALID_CREDENTIALS':
        return new HttpError(401, 'INVALID_CREDENTIALS', error.message);
      case 'AUTH_REQUIRED':
        return new HttpError(401, 'AUTH_REQUIRED', error.message);
    }
  }
  if (error instanceof ZodError) {
    return new HttpError(400, 'VALIDATION_ERROR', 'Request validation failed');
  }

  const statusCode = statusCodeOf(error);
  if (statusCode === 429) {
    return new HttpError(429, 'RATE_LIMITED', 'Too many requests');
  }
  if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
    return new HttpError(
      statusCode,
      'VALIDATION_ERROR',
      'Request validation failed',
    );
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'Internal server error');
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const httpError = mapError(error);
    if (httpError.statusCode >= 500 && !(error instanceof HttpError)) {
      request.log.error(safeErrorMetadata(error), 'Request failed');
    }
    return reply.status(httpError.statusCode).send({
      error: {
        code: httpError.code,
        message: httpError.message,
      },
    });
  });
}
