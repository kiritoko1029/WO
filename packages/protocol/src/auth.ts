import { z } from 'zod';

import {
  createAckEnvelopeSchema,
  createRequestEnvelopeSchema,
  opaqueTokenSchema,
} from './envelope.js';

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
