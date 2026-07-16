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

export const authRegisterResponseSchema = authResponseSchema;
export const authLoginResponseSchema = authResponseSchema;
export const authRefreshResponseSchema = authResponseSchema;

export const authLogoutResponseSchema = z
  .object({
    loggedOut: z.literal(true),
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
