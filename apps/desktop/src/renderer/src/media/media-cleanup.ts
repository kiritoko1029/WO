export type MediaCleanupStep = () => void | Promise<void>;

export function createIdempotentCleanup(
  steps: readonly MediaCleanupStep[],
): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;
  return () => {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors: unknown[] = [];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Media cleanup failed');
      }
    })();
    return cleanupPromise;
  };
}
