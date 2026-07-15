import { z } from 'zod';

import { failureAckPayloadSchema } from './errors.js';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_IDENTIFIER_LENGTH = 128;

const createBoundedIdentifierSchema = <Brand extends PropertyKey>() =>
  z.string().max(MAX_IDENTIFIER_LENGTH).trim().min(1).brand<Brand>();

export const requestIdSchema = createBoundedIdentifierSchema<'RequestId'>();
export const eventIdSchema = createBoundedIdentifierSchema<'EventId'>();
export const roomIdSchema = createBoundedIdentifierSchema<'RoomId'>();
export const memberIdSchema = createBoundedIdentifierSchema<'MemberId'>();
export const transportIdSchema = createBoundedIdentifierSchema<'TransportId'>();
export const producerIdSchema = createBoundedIdentifierSchema<'ProducerId'>();
export const consumerIdSchema = createBoundedIdentifierSchema<'ConsumerId'>();
export const leaseIdSchema = createBoundedIdentifierSchema<'LeaseId'>();
export const opaqueTokenSchema = z.string().trim().min(1).max(4_096);
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const createRequestEnvelopeSchema = <
  const Type extends string,
  PayloadSchema extends z.ZodType,
>(
  type: Type,
  payload: PayloadSchema,
) =>
  z
    .object({
      version: z.literal(PROTOCOL_VERSION),
      requestId: requestIdSchema,
      type: z.literal(type),
      payload,
    })
    .strict();

export const createBroadcastEnvelopeSchema = <
  const Type extends string,
  PayloadSchema extends z.ZodType,
>(
  type: Type,
  payload: PayloadSchema,
) =>
  z
    .object({
      version: z.literal(PROTOCOL_VERSION),
      eventId: eventIdSchema,
      type: z.literal(type),
      payload,
    })
    .strict();

export const createAckEnvelopeSchema = <
  const RequestType extends string,
  DataSchema extends z.ZodType,
>(
  requestType: RequestType,
  data: DataSchema,
) => {
  const successAckPayloadSchema = z
    .object({
      ok: z.literal(true),
      data,
    })
    .strict();

  return z
    .object({
      version: z.literal(PROTOCOL_VERSION),
      requestId: requestIdSchema,
      type: z.literal(`${requestType}.ack`),
      payload: z.discriminatedUnion('ok', [
        successAckPayloadSchema,
        failureAckPayloadSchema,
      ]),
    })
    .strict();
};

export type RequestId = z.infer<typeof requestIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type RoomId = z.infer<typeof roomIdSchema>;
export type MemberId = z.infer<typeof memberIdSchema>;
export type TransportId = z.infer<typeof transportIdSchema>;
export type ProducerId = z.infer<typeof producerIdSchema>;
export type ConsumerId = z.infer<typeof consumerIdSchema>;
export type LeaseId = z.infer<typeof leaseIdSchema>;
