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
  'INVALID_CREDENTIALS',
  'AUTH_REQUIRED',
  'ROOM_CODE_INVALID',
  'ROOM_CODE_EXPIRED',
  'ROOM_CLOSED',
  'STALE_CONNECTION',
  'STALE_NEGOTIATION',
  'RATE_LIMITED',
  'SIGNALING_UNAVAILABLE',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export const P2P_ERROR_CODES = [
  'ROOM_FULL',
  'FORBIDDEN',
  'SCREEN_SHARE_BUSY',
  'LEASE_LOST',
  'INVALID_STATE',
  'UNSUPPORTED_PROTOCOL',
  'VALIDATION_ERROR',
  'INVALID_CREDENTIALS',
  'AUTH_REQUIRED',
  'ROOM_CODE_INVALID',
  'ROOM_CODE_EXPIRED',
  'ROOM_CLOSED',
  'STALE_CONNECTION',
  'STALE_NEGOTIATION',
  'RATE_LIMITED',
  'SIGNALING_UNAVAILABLE',
] as const;

export const p2pErrorCodeSchema = z.enum(P2P_ERROR_CODES);

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

export const p2pProtocolErrorSchema = protocolErrorSchema.extend({
  code: p2pErrorCodeSchema,
});

export const p2pFailureAckPayloadSchema = z
  .object({
    ok: z.literal(false),
    error: p2pProtocolErrorSchema,
  })
  .strict();

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type P2pErrorCode = z.infer<typeof p2pErrorCodeSchema>;
export type ProtocolError = z.infer<typeof protocolErrorSchema>;
export type P2pProtocolError = z.infer<typeof p2pProtocolErrorSchema>;
export type FailureAckPayload = z.infer<typeof failureAckPayloadSchema>;
export type P2pFailureAckPayload = z.infer<typeof p2pFailureAckPayloadSchema>;
