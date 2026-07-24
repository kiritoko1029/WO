import { z } from 'zod';

import {
  createAckEnvelopeSchema,
  createRequestEnvelopeSchema,
  opaqueTokenSchema,
  userIdSchema,
} from './envelope.js';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(128);
export const displayNameSchema = z.string().trim().min(1).max(100);

export const authRegisterBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
  })
  .strict();

export const authLoginBodySchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const authRefreshBodySchema = z
  .object({
    refreshToken: opaqueTokenSchema,
  })
  .strict();

export const authLogoutBodySchema = authRefreshBodySchema;

export const publicAuthUserSchema = z
  .object({
    userId: userIdSchema,
    email: emailSchema,
    displayName: displayNameSchema,
  })
  .strict();

export const authResponseSchema = z
  .object({
    user: publicAuthUserSchema,
    accessToken: opaqueTokenSchema,
    refreshToken: opaqueTokenSchema,
    accessTokenExpiresInSeconds: z.number().int().positive().max(86_400),
  })
  .strict();

export const authVerificationRequiredResponseSchema = z
  .object({
    status: z.literal('verification_required'),
    email: emailSchema,
  })
  .strict();

export const authAuthenticatedResponseSchema = authResponseSchema.extend({
  status: z.literal('authenticated').optional(),
});

export function parseAuthenticatedAuthResponse(input: unknown): AuthResponse {
  const response = authAuthenticatedResponseSchema.parse(input);
  return authResponseSchema.parse({
    user: response.user,
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    accessTokenExpiresInSeconds: response.accessTokenExpiresInSeconds,
  });
}

export const authRegisterResponseSchema = z.union([
  authAuthenticatedResponseSchema,
  authVerificationRequiredResponseSchema,
]);
export const authLoginResponseSchema = authAuthenticatedResponseSchema;
export const authRefreshResponseSchema = authResponseSchema;

export const authLogoutResponseSchema = z
  .object({
    loggedOut: z.literal(true),
  })
  .strict();

export const authVerifyEmailBodySchema = z
  .object({
    email: emailSchema,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u),
  })
  .strict();

export const authResendVerificationBodySchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const authChangePasswordBodySchema = z
  .object({
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.currentPassword === value.newPassword) {
      context.addIssue({
        code: 'custom',
        message: 'new password must differ from current password',
        path: ['newPassword'],
      });
    }
  });

export const authChangePasswordResponseSchema = z
  .object({
    changed: z.literal(true),
  })
  .strict();

export const authRequestEmailChangeBodySchema = z
  .object({
    newEmail: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const authConfirmEmailChangeBodySchema = z
  .object({
    newEmail: emailSchema,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/u),
  })
  .strict();

export const authEmailChangeRequestedResponseSchema = z
  .object({
    status: z.literal('verification_required'),
    email: emailSchema,
  })
  .strict();

export const authRefreshPayloadSchema = z
  .object({
    refreshToken: opaqueTokenSchema,
  })
  .strict();

export const authRefreshRequestSchema = createRequestEnvelopeSchema(
  'auth.refresh',
  authRefreshPayloadSchema,
);

export const authRefreshAckDataSchema = z
  .object({
    accessToken: opaqueTokenSchema,
    refreshToken: opaqueTokenSchema.optional(),
    expiresInSeconds: z.number().int().positive().max(86_400),
  })
  .strict();

export const authRefreshAckSchema = createAckEnvelopeSchema(
  'auth.refresh',
  authRefreshAckDataSchema,
);

export type AuthRefreshPayload = z.infer<typeof authRefreshPayloadSchema>;
export type AuthRefreshRequest = z.infer<typeof authRefreshRequestSchema>;
export type AuthRefreshAck = z.infer<typeof authRefreshAckSchema>;
export type Email = z.infer<typeof emailSchema>;
export type Password = z.infer<typeof passwordSchema>;
export type DisplayName = z.infer<typeof displayNameSchema>;
export type AuthRegisterBody = z.infer<typeof authRegisterBodySchema>;
export type AuthLoginBody = z.infer<typeof authLoginBodySchema>;
export type AuthRefreshBody = z.infer<typeof authRefreshBodySchema>;
export type AuthLogoutBody = z.infer<typeof authLogoutBodySchema>;
export type PublicAuthUser = z.infer<typeof publicAuthUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type AuthRegisterResponse = z.infer<typeof authRegisterResponseSchema>;
export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>;
export type AuthRefreshResponse = z.infer<typeof authRefreshResponseSchema>;
export type AuthLogoutResponse = z.infer<typeof authLogoutResponseSchema>;
export type AuthVerifyEmailBody = z.infer<typeof authVerifyEmailBodySchema>;
export type AuthResendVerificationBody = z.infer<
  typeof authResendVerificationBodySchema
>;
export type AuthChangePasswordBody = z.infer<
  typeof authChangePasswordBodySchema
>;
export type AuthChangePasswordResponse = z.infer<
  typeof authChangePasswordResponseSchema
>;
export type AuthRequestEmailChangeBody = z.infer<
  typeof authRequestEmailChangeBodySchema
>;
export type AuthConfirmEmailChangeBody = z.infer<
  typeof authConfirmEmailChangeBodySchema
>;
export type AuthEmailChangeRequestedResponse = z.infer<
  typeof authEmailChangeRequestedResponseSchema
>;
export type AuthVerificationRequiredResponse = z.infer<
  typeof authVerificationRequiredResponseSchema
>;
