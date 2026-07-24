import {
  createHash,
  randomInt,
  randomUUID as nodeRandomUUID,
} from 'node:crypto';
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
  authChangePasswordBodySchema,
  authChangePasswordResponseSchema,
  authConfirmEmailChangeBodySchema,
  authEmailChangeRequestedResponseSchema,
  authLoginBodySchema,
  authLogoutBodySchema,
  authLogoutResponseSchema,
  authRefreshBodySchema,
  authRefreshResponseSchema,
  authRegisterBodySchema,
  authRegisterResponseSchema,
  authRequestEmailChangeBodySchema,
  authResendVerificationBodySchema,
  authResponseSchema,
  authVerificationRequiredResponseSchema,
  authVerifyEmailBodySchema,
  publicAuthUserSchema,
  type AuthChangePasswordBody,
  type AuthChangePasswordResponse,
  type AuthConfirmEmailChangeBody,
  type AuthEmailChangeRequestedResponse,
  type AuthLoginBody,
  type AuthLogoutBody,
  type AuthLogoutResponse,
  type AuthRefreshBody,
  type AuthRefreshResponse,
  type AuthRegisterBody,
  type AuthRegisterResponse,
  type AuthRequestEmailChangeBody,
  type AuthResendVerificationBody,
  type AuthResponse,
  type AuthVerifyEmailBody,
  type PublicAuthUser,
} from '@wo/protocol';

import {
  ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  type AccessTokenService,
} from './access-token.ts';
import type { EmailDelivery } from './email-delivery.ts';
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
  | 'AUTH_REQUIRED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'EMAIL_DOMAIN_NOT_ALLOWED'
  | 'EMAIL_NOT_VERIFIED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_VERIFICATION_CODE'
  | 'SERVICE_UNAVAILABLE';

const authServiceErrorMessages: Record<AuthServiceErrorCode, string> = {
  AUTH_REQUIRED: 'Authentication is required',
  EMAIL_ALREADY_REGISTERED: 'Email is already registered',
  EMAIL_DOMAIN_NOT_ALLOWED: 'Email domain is not allowed',
  EMAIL_NOT_VERIFIED: 'Email address is not verified',
  INVALID_CREDENTIALS: 'Invalid email or password',
  INVALID_VERIFICATION_CODE: 'Verification code is invalid or expired',
  SERVICE_UNAVAILABLE: 'Email delivery is temporarily unavailable',
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
  login(input: AuthLoginBody): Promise<AuthResponse>;
  refresh(input: AuthRefreshBody): Promise<AuthRefreshResponse>;
  logout(input: AuthLogoutBody): Promise<AuthLogoutResponse>;
  verifyEmail(input: AuthVerifyEmailBody): Promise<AuthResponse>;
  resendVerification(
    input: AuthResendVerificationBody,
  ): Promise<AuthEmailChangeRequestedResponse>;
  changePassword(
    userId: string,
    input: AuthChangePasswordBody,
  ): Promise<AuthChangePasswordResponse>;
  requestEmailChange(
    userId: string,
    input: AuthRequestEmailChangeBody,
  ): Promise<AuthEmailChangeRequestedResponse>;
  confirmEmailChange(
    userId: string,
    input: AuthConfirmEmailChangeBody,
  ): Promise<AuthResponse>;
}

export interface AuthServiceEmailPolicy {
  readonly domainAllowlist: readonly string[];
  readonly verificationRequired: boolean;
  readonly codeTtlSeconds: number;
}

export interface AuthServiceDependencies {
  readonly identityRepository: IdentityRepository;
  readonly sessionRepository: SessionRepository;
  readonly accessTokenService: AccessTokenService;
  readonly dummyPasswordHash: string;
  readonly emailPolicy: AuthServiceEmailPolicy;
  readonly emailDelivery: EmailDelivery;
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

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

function assertEmailDomainAllowed(
  email: string,
  allowlist: readonly string[],
): void {
  if (allowlist.length === 0) return;
  const domain = emailDomain(email);
  if (!allowlist.includes(domain)) {
    throw new AuthServiceError('EMAIL_DOMAIN_NOT_ALLOWED');
  }
}

function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
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
  const policy = dependencies.emailPolicy;

  async function prepareSession(
    identity: EmailUserRecord,
    operationTime: Date,
    sessionId: string,
  ): Promise<
    Readonly<{
      response: AuthResponse;
      tokenHash: ReturnType<typeof hashRefreshToken>;
      expiresAt: Date;
      refreshToken: string;
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
      refreshToken,
    };
  }

  async function issueLoginSession(
    identity: EmailUserRecord,
    operationTime: Date,
  ): Promise<AuthResponse> {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const prepared = await prepareSession(identity, operationTime, sessionId);
    try {
      await dependencies.sessionRepository.createRefreshSession({
        sessionId,
        familyId,
        userId: identity.user.id,
        tokenHash: prepared.tokenHash,
        expiresAt: prepared.expiresAt,
      });
    } catch (error) {
      throwLoginSessionError(error);
    }
    return prepared.response;
  }

  async function issueVerificationChallenge(
    userId: string,
    email: string,
    purpose: 'register' | 'rebind',
    operationTime: Date,
  ): Promise<string> {
    const code = generateVerificationCode();
    const challengeId = randomUUID();
    await dependencies.identityRepository.replaceEmailVerificationChallenge({
      challengeId,
      userId,
      emailNormalized: email,
      purpose,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(
        operationTime.getTime() + policy.codeTtlSeconds * 1_000,
      ),
    });
    const subject =
      purpose === 'register' ? 'WO 邮箱验证码' : 'WO 换绑邮箱验证码';
    try {
      await dependencies.emailDelivery.send({
        to: email,
        subject,
        text: `您的验证码是 ${code}，${Math.floor(policy.codeTtlSeconds / 60)} 分钟内有效。如非本人操作请忽略。`,
      });
    } catch {
      throw new AuthServiceError('SERVICE_UNAVAILABLE');
    }
    return code;
  }

  return {
    async register(input) {
      const operationTime = snapshotDate(now());
      const body = authRegisterBodySchema.parse(input);
      assertEmailDomainAllowed(body.email, policy.domainAllowlist);
      const userId = randomUUID();
      const passwordHash = await hashPassword(body.password);

      try {
        await dependencies.identityRepository.createEmailUser({
          userId,
          emailNormalized: body.email,
          displayName: body.displayName,
          passwordHash,
        });
      } catch (error) {
        if (
          error instanceof IdentityRepositoryError &&
          error.code === 'IDENTITY_CONFLICT'
        ) {
          throw new AuthServiceError('EMAIL_ALREADY_REGISTERED');
        }
        throw error;
      }

      if (!policy.verificationRequired) {
        await dependencies.identityRepository.markEmailVerified(
          userId,
          operationTime,
        );
        const identity =
          await dependencies.identityRepository.findEmailUserById(userId);
        if (identity === null) {
          throw new AuthServiceError('INVALID_CREDENTIALS');
        }
        const session = await issueLoginSession(identity, operationTime);
        return authRegisterResponseSchema.parse({
          ...session,
          status: 'authenticated',
        });
      }

      await issueVerificationChallenge(
        userId,
        body.email,
        'register',
        operationTime,
      );
      return authVerificationRequiredResponseSchema.parse({
        status: 'verification_required',
        email: body.email,
      });
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
      if (policy.verificationRequired && credential.verifiedAt === null) {
        throw new AuthServiceError('EMAIL_NOT_VERIFIED');
      }
      return issueLoginSession(credential, operationTime);
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
      if (policy.verificationRequired && identity.verifiedAt === null) {
        throw new AuthServiceError('EMAIL_NOT_VERIFIED');
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

    async verifyEmail(input) {
      const operationTime = snapshotDate(now());
      const body = authVerifyEmailBodySchema.parse(input);
      const credential =
        await dependencies.identityRepository.findEmailCredential(body.email);
      if (credential === null || credential.user.disabledAt !== null) {
        throw new AuthServiceError('INVALID_VERIFICATION_CODE');
      }
      if (credential.verifiedAt !== null) {
        return issueLoginSession(credential, operationTime);
      }
      const challenge =
        await dependencies.identityRepository.findLatestEmailVerificationChallenge(
          credential.user.id,
          'register',
        );
      if (
        challenge === null ||
        challenge.emailNormalized !== body.email ||
        challenge.codeHash !== hashVerificationCode(body.code) ||
        challenge.expiresAt.getTime() <= operationTime.getTime()
      ) {
        throw new AuthServiceError('INVALID_VERIFICATION_CODE');
      }
      const consumed =
        await dependencies.identityRepository.consumeEmailVerificationChallenge(
          challenge.id,
        );
      if (!consumed) {
        throw new AuthServiceError('INVALID_VERIFICATION_CODE');
      }
      await dependencies.identityRepository.markEmailVerified(
        credential.user.id,
        operationTime,
      );
      const identity = await dependencies.identityRepository.findEmailUserById(
        credential.user.id,
      );
      if (identity === null) {
        throw new AuthServiceError('INVALID_CREDENTIALS');
      }
      return issueLoginSession(identity, operationTime);
    },

    async resendVerification(input) {
      const operationTime = snapshotDate(now());
      const body = authResendVerificationBodySchema.parse(input);
      const credential =
        await dependencies.identityRepository.findEmailCredential(body.email);
      // Avoid account enumeration: always return the same shape.
      if (
        credential !== null &&
        credential.user.disabledAt === null &&
        credential.verifiedAt === null
      ) {
        await issueVerificationChallenge(
          credential.user.id,
          body.email,
          'register',
          operationTime,
        );
      }
      return authEmailChangeRequestedResponseSchema.parse({
        status: 'verification_required',
        email: body.email,
      });
    },

    async changePassword(userId, input) {
      const body = authChangePasswordBodySchema.parse(input);
      const identity =
        await dependencies.identityRepository.findEmailUserById(userId);
      if (identity === null || identity.user.disabledAt !== null) {
        throw new AuthServiceError('AUTH_REQUIRED');
      }
      const credential =
        await dependencies.identityRepository.findEmailCredential(
          identity.emailNormalized,
        );
      if (credential === null) {
        throw new AuthServiceError('AUTH_REQUIRED');
      }
      const matches = await verifyPassword(
        credential.passwordHash,
        body.currentPassword,
      );
      if (!matches) {
        throw new AuthServiceError('INVALID_CREDENTIALS');
      }
      const nextHash = await hashPassword(body.newPassword);
      await dependencies.identityRepository.updatePasswordHash(
        userId,
        nextHash,
      );
      return authChangePasswordResponseSchema.parse({ changed: true });
    },

    async requestEmailChange(userId, input) {
      const operationTime = snapshotDate(now());
      const body = authRequestEmailChangeBodySchema.parse(input);
      assertEmailDomainAllowed(body.newEmail, policy.domainAllowlist);
      const identity =
        await dependencies.identityRepository.findEmailUserById(userId);
      if (identity === null || identity.user.disabledAt !== null) {
        throw new AuthServiceError('AUTH_REQUIRED');
      }
      if (identity.emailNormalized === body.newEmail) {
        throw new AuthServiceError('EMAIL_ALREADY_REGISTERED');
      }
      const credential =
        await dependencies.identityRepository.findEmailCredential(
          identity.emailNormalized,
        );
      if (credential === null) {
        throw new AuthServiceError('AUTH_REQUIRED');
      }
      const matches = await verifyPassword(
        credential.passwordHash,
        body.password,
      );
      if (!matches) {
        throw new AuthServiceError('INVALID_CREDENTIALS');
      }
      const existing =
        await dependencies.identityRepository.findEmailCredential(
          body.newEmail,
        );
      if (existing !== null) {
        throw new AuthServiceError('EMAIL_ALREADY_REGISTERED');
      }
      await issueVerificationChallenge(
        userId,
        body.newEmail,
        'rebind',
        operationTime,
      );
      return authEmailChangeRequestedResponseSchema.parse({
        status: 'verification_required',
        email: body.newEmail,
      });
    },

    async confirmEmailChange(userId, input) {
      const operationTime = snapshotDate(now());
      const body = authConfirmEmailChangeBodySchema.parse(input);
      assertEmailDomainAllowed(body.newEmail, policy.domainAllowlist);
      const challenge =
        await dependencies.identityRepository.findLatestEmailVerificationChallenge(
          userId,
          'rebind',
        );
      if (
        challenge === null ||
        challenge.emailNormalized !== body.newEmail ||
        challenge.codeHash !== hashVerificationCode(body.code) ||
        challenge.expiresAt.getTime() <= operationTime.getTime()
      ) {
        throw new AuthServiceError('INVALID_VERIFICATION_CODE');
      }
      const consumed =
        await dependencies.identityRepository.consumeEmailVerificationChallenge(
          challenge.id,
        );
      if (!consumed) {
        throw new AuthServiceError('INVALID_VERIFICATION_CODE');
      }
      try {
        const identity =
          await dependencies.identityRepository.updateEmailIdentity(
            userId,
            body.newEmail,
          );
        return issueLoginSession(identity, operationTime);
      } catch (error) {
        if (
          error instanceof IdentityRepositoryError &&
          error.code === 'IDENTITY_CONFLICT'
        ) {
          throw new AuthServiceError('EMAIL_ALREADY_REGISTERED');
        }
        throw error;
      }
    },
  };
}
