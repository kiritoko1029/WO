import { z } from 'zod';

export const ERROR_CODES = [
  'ROOM_FULL',
  'FORBIDDEN',
  'SCREEN_SHARE_BUSY',
  'LEASE_LOST',
  'INVALID_STATE',
  'MEDIA_NODE_UNAVAILABLE',
  'UNSUPPORTED_PROTOCOL',
  'VALIDATION_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export const protocolErrorSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().trim().min(1).max(256),
    retryable: z.boolean().optional(),
    field: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export const failureAckPayloadSchema = z
  .object({
    ok: z.literal(false),
    error: protocolErrorSchema,
  })
  .strict();

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
export type FailureAckPayload = z.infer<typeof failureAckPayloadSchema>;
