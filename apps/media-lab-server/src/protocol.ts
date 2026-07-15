import { z } from 'zod';

export const boundedIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const jsonObjectSchema = z.record(z.string().max(128), z.unknown());
const emptyDataSchema = z.object({}).strict();

export const requestMessageSchema = z.discriminatedUnion('method', [
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('getRouterRtpCapabilities'),
      data: emptyDataSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('listProducers'),
      data: emptyDataSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('createTransport'),
      data: z.object({ direction: z.enum(['send', 'recv']) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('connectTransport'),
      data: z
        .object({
          transportId: boundedIdSchema,
          dtlsParameters: jsonObjectSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('produce'),
      data: z
        .object({
          transportId: boundedIdSchema,
          kind: z.literal('video'),
          rtpParameters: jsonObjectSchema,
          appData: jsonObjectSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('consume'),
      data: z
        .object({
          transportId: boundedIdSchema,
          producerId: boundedIdSchema,
          rtpCapabilities: jsonObjectSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('resumeConsumer'),
      data: z.object({ consumerId: boundedIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id: boundedIdSchema,
      method: z.literal('close'),
      data: z
        .object({
          resourceType: z.enum(['transport', 'producer', 'consumer']),
          resourceId: boundedIdSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const ackMessageSchema = z
  .object({
    type: z.literal('ack'),
    id: boundedIdSchema,
    data: jsonObjectSchema,
  })
  .strict();

export const errorMessageSchema = z
  .object({
    type: z.literal('error'),
    id: boundedIdSchema,
    error: z
      .object({
        code: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Z][A-Z0-9_]*$/),
        message: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

export type LabRequest = z.infer<typeof requestMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export function parseClientMessage(message: string): LabRequest {
  try {
    return requestMessageSchema.parse(JSON.parse(message));
  } catch {
    throw new Error('Invalid signaling message');
  }
}

export function createAck(
  id: string,
  data: Record<string, unknown>,
): AckMessage {
  return ackMessageSchema.parse({ type: 'ack', id, data });
}

export function createError(
  id: string,
  code: string,
  message: string,
): ErrorMessage {
  return errorMessageSchema.parse({
    type: 'error',
    id,
    error: { code, message },
  });
}
