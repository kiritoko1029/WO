import type { MediaStats } from '@wo/media-policy';

import type { BitrateChangeEvent } from './bitrate-controller.js';

export interface MediaLabStatsExportInput {
  readonly role: 'publisher' | 'receiver';
  readonly labUrl: string;
  readonly exportedAt: string;
  readonly samples: readonly MediaStats[];
  readonly events: readonly BitrateChangeEvent[];
}

export function buildMediaLabStatsExport(input: MediaLabStatsExportInput) {
  return {
    schemaVersion: 1 as const,
    role: input.role,
    labUrl: input.labUrl,
    exportedAt: input.exportedAt,
    samples: [...input.samples],
    events: input.events.map((event) => ({
      requestedBitrateBps: event.requestedBitrateBps,
      clampedBitrateBps: event.clampedBitrateBps,
      requestedAt: event.requestedAt,
      appliedAt: event.appliedAt,
      success: event.success,
      error: event.error
        ? { code: event.error.code, message: event.error.message }
        : null,
      producerIdBefore: event.producerIdBefore,
      producerIdAfter: event.producerIdAfter,
      producerIdUnchanged: event.producerIdUnchanged,
    })),
  };
}
