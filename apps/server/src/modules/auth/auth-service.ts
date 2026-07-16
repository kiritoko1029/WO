import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  IdentityRepositoryError,
  SessionRepositoryError,
  type EmailUserRecord,
  type IdentityRepository,
  type SessionRepository,
  type SessionRepositoryErrorCode,
} from '@wo/database';
import {
  authLoginBodySchema,
  authLogoutBodySchema,
  authLogoutResponseSchema,
  authRefreshBodySchema,
  authRefreshResponseSchema,
  authRegisterBodySchema,
  authResponseSchema,
  publicAuthUserSchema,
  type AuthLoginBody,
  type AuthLogoutBody,
  type AuthLogoutResponse,
  type AuthRefreshBody,
  type AuthRefreshResponse,
  type AuthRegisterBody,
  type AuthRegisterResponse,
  type PublicAuthUser,
} from '@wo/protocol';

import {
  ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  type AccessTokenService,
} from './access-token.ts';
import {
  hashPassword as defaultHashPassword,
  verifyPassword as defaultVerifyPassword,
} from './password.ts';
import {
  REFRESH_TOKEN_LIFETIME_MILLISECONDS,
  generateRefreshToken as defaultGenerateRefreshToken,
  hashRefreshToken,
} from './refresh-token.ts';

export type AuthServiceErrorCode =
  'AUTH_REQUIRED' | 'EMAIL_ALREADY_REGISTERED' | 'INVALID_CREDENTIALS';

const authServiceErrorMessages: Record<AuthServiceErrorCode, string> = {
  AUTH_REQUIRED: 'Authentication is required',
  EMAIL_ALREADY_REGISTERED: 'Email is already registered',
  INVALID_CREDENTIALS: 'Invalid email or password',
};

export class AuthServiceError extends Error {
  readonly code: AuthServiceErrorCode;

  constructor(code: AuthServiceErrorCode) {
    super(authServiceErrorMessages[code]);
    this.name = 'AuthServiceError';
    this.code = code;
  }
}

export interface AuthService {
  register(input: AuthRegisterBody): Promise<AuthRegisterResponse>;
  login(input: AuthLoginBody): Promise<AuthRegisterResponse>;
  refresh(input: AuthRefreshBody): Promise<AuthRefreshResponse>;
  logout(input: AuthLogoutBody): Promise<AuthLogoutResponse>;
}

export interface AuthServiceDependencies {
  readonly identityRepository: IdentityRepository;
  readonly sessionRepository: SessionRepository;
  readonly accessTokenService: AccessTokenService;
  readonly dummyPasswordHash: string;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly hashPassword?: (password: string) => Promise<string>;
  readonly verifyPassword?: (
    passwordHash: string,
    password: string,
  ) => Promise<boolean>;
  readonly generateRefreshToken?: () => string;
}

function snapshotDate(value: Date): Date {
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError('Authentication clock must return a valid Date');
  }
  return new Date(milliseconds);
}

function toPublicUser(identity: EmailUserRecord): PublicAuthUser {
  return publicAuthUserSchema.parse({
    userId: identity.user.id,
    email: identity.emailNormalized,
    displayName: identity.user.displayName,
  });
}

function isSessionRepositoryErrorCode(
  code: unknown,
): code is SessionRepositoryErrorCode {
  switch (code) {
    case 'REFRESH_SESSION_CONFLICT':
    case 'REFRESH_SESSION_EXPIRED':
    case 'REFRESH_SESSION_NOT_FOUND':
    case 'REFRESH_SESSION_PERSISTENCE_ERROR':
    case 'REFRESH_SESSION_REVOKED':
    case 'REFRESH_TOKEN_REUSED':
    case 'USER_DISABLED':
    case 'USER_NOT_FOUND':
      return true;
    default:
      return false;
  }
}

function sessionRepositoryErrorCode(
  error: unknown,
): SessionRepositoryErrorCode | null {
  if (error instanceof SessionRepositoryError) {
    return error.code;
  }
  if (!utilTypes.isNativeError(error)) {
    return null;
  }
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return candidate.name === 'SessionRepositoryError' &&
    isSessionRepositoryErrorCode(candidate.code)
    ? candidate.code
    : null;
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled session repository error: ${String(value)}`);
}

function throwRefreshError(error: unknown): never {
  const code = sessionRepositoryErrorCode(error);
  if (code === null) {
    throw error;
  }
  switch (code) {
    case 'REFRESH_SESSION_NOT_FOUND':
    case 'REFRESH_SESSION_EXPIRED':
    case 'REFRESH_SESSION_REVOKED':
    case 'REFRESH_TOKEN_REUSED':
    case 'USER_DISABLED':
    case 'USER_NOT_FOUND':
      throw new AuthServiceError('AUTH_REQUIRED');
    case 'REFRESH_SESSION_CONFLICT':
    case 'REFRESH_SESSION_PERSISTENCE_ERROR':
      throw error;
    default:
      return assertNever(code);
  }
}

function throwLoginSessionError(error: unknown): never {
  const code = sessionRepositoryErrorCode(error);
  if (code === 'USER_DISABLED' || code === 'USER_NOT_FOUND') {
    throw new AuthServiceError('INVALID_CREDENTIALS');
  }
  throw error;
}

function isIdempotentLogoutError(error: unknown): boolean {
  const code = sessionRepositoryErrorCode(error);
  if (code === null) {
    return false;
  }
  switch (code) {
    case 'REFRESH_SESSION_NOT_FOUND':
      return true;
    case 'REFRESH_SESSION_CONFLICT':
    case 'REFRESH_SESSION_EXPIRED':
    case 'REFRESH_SESSION_PERSISTENCE_ERROR':
    case 'REFRESH_SESSION_REVOKED':
    case 'REFRESH_TOKEN_REUSED':
    case 'USER_DISABLED':
    case 'USER_NOT_FOUND':
      return false;
    default:
      return assertNever(code);
  }
}

export function createAuthService(
  dependencies: AuthServiceDependencies,
): AuthService {
  const now = dependencies.now ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
  const hashPassword = dependencies.hashPassword ?? defaultHashPassword;
  const verifyPassword = dependencies.verifyPassword ?? defaultVerifyPassword;
  const generateRefreshToken =
    dependencies.generateRefreshToken ?? defaultGenerateRefreshToken;

  async function prepareSession(
    identity: EmailUserRecord,
    operationTime: Date,
    sessionId: string,
  ): Promise<
    Readonly<{
      response: AuthRegisterResponse;
      tokenHash: ReturnType<typeof hashRefreshToken>;
      expiresAt: Date;
    }>
  > {
    const refreshToken = generateRefreshToken();
    const tokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(
      operationTime.getTime() + REFRESH_TOKEN_LIFETIME_MILLISECONDS,
    );
    const user = toPublicUser(identity);
    const accessToken = await dependencies.accessTokenService.sign({
      userId: identity.user.id,
      sessionId,
    });

    return {
      response: authResponseSchema.parse({
        user,
        accessToken,
        refreshToken,
        accessTokenExpiresInSeconds: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      }),
      tokenHash,
      expiresAt,
    };
  }

  return {
    async register(input) {
      const operationTime = snapshotDate(now());
      const body = authRegisterBodySchema.parse(input);
      const userId = randomUUID();
      const identityId = randomUUID();
      const sessionId = randomUUID();
      const familyId = randomUUID();
      const passwordHash = await hashPassword(body.password);
      const identity: EmailUserRecord = {
        emailNormalized: body.email,
        user: {
          id: userId,
          displayName: body.displayName,
          createdAt: operationTime,
          disabledAt: null,
        },
      };
      const prepared = await prepareSession(identity, operationTime, sessionId);
      try {
        await dependencies.identityRepository.createEmailUserWithRefreshSession(
          {
            userId,
            identityId,
            emailNormalized: body.email,
            displayName: body.displayName,
            passwordHash,
            session: {
              sessionId,
              familyId,
              tokenHash: prepared.tokenHash,
              expiresAt: prepared.expiresAt,
            },
          },
        );
      } catch (error) {
        if (
          error instanceof IdentityRepositoryError &&
          error.code === 'IDENTITY_CONFLICT'
        ) {
          throw new AuthServiceError('EMAIL_ALREADY_REGISTERED');
        }
        throw error;
      }
      return prepared.response;
    },

    async login(input) {
      const operationTime = snapshotDate(now());
      const body = authLoginBodySchema.parse(input);
      const credential =
        await dependencies.identityRepository.findEmailCredential(body.email);
      const passwordHash =
        credential?.passwordHash ?? dependencies.dummyPasswordHash;
      const passwordMatches = await verifyPassword(passwordHash, body.password);
      if (
        credential === null ||
        !passwordMatches ||
        credential.user.disabledAt !== null
      ) {
        throw new AuthServiceError('INVALID_CREDENTIALS');
      }
      const sessionId = randomUUID();
      const familyId = randomUUID();
      const prepared = await prepareSession(
        credential,
        operationTime,
        sessionId,
      );
      try {
        await dependencies.sessionRepository.createRefreshSession({
          sessionId,
          familyId,
          userId: credential.user.id,
          tokenHash: prepared.tokenHash,
          expiresAt: prepared.expiresAt,
        });
      } catch (error) {
        throwLoginSessionError(error);
      }
      return prepared.response;
    },

    async refresh(input) {
      const operationTime = snapshotDate(now());
      const body = authRefreshBodySchema.parse(input);
      const presentedTokenHash = hashRefreshToken(body.refreshToken);
      let userId: string | null;
      try {
        userId =
          await dependencies.sessionRepository.findRefreshSessionUserId(
            presentedTokenHash,
          );
      } catch (error) {
        throwRefreshError(error);
      }
      if (userId === null) {
        throw new AuthServiceError('AUTH_REQUIRED');
      }
      const identity =
        await dependencies.identityRepository.findEmailUserById(userId);
      if (identity === null || identity.user.disabledAt !== null) {
        throw new AuthServiceError('AUTH_REQUIRED');
      }
      const replacementSessionId = randomUUID();
      const replacementRefreshToken = generateRefreshToken();
      const replacementTokenHash = hashRefreshToken(replacementRefreshToken);
      const replacementExpiresAt = new Date(
        operationTime.getTime() + REFRESH_TOKEN_LIFETIME_MILLISECONDS,
      );
      const user = toPublicUser(identity);
      const accessToken = await dependencies.accessTokenService.sign({
        userId,
        sessionId: replacementSessionId,
      });
      const response: AuthRefreshResponse = authRefreshResponseSchema.parse({
        user,
        accessToken,
        refreshToken: replacementRefreshToken,
        accessTokenExpiresInSeconds: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
      });
      try {
        await dependencies.sessionRepository.rotateRefreshSession({
          replacementSessionId,
          presentedTokenHash,
          replacementTokenHash,
          replacementExpiresAt,
        });
      } catch (error) {
        throwRefreshError(error);
      }
      return response;
    },

    async logout(input) {
      const body = authLogoutBodySchema.parse(input);
      const response = authLogoutResponseSchema.parse({ loggedOut: true });
      try {
        await dependencies.sessionRepository.revokeRefreshTokenFamily({
          presentedTokenHash: hashRefreshToken(body.refreshToken),
        });
      } catch (error) {
        if (!isIdempotentLogoutError(error)) {
          throw error;
        }
      }
      return response;
    },
  };
}
