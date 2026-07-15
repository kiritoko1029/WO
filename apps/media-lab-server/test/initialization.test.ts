import { beforeEach, expect, test, vi } from 'vitest';

const workerModule = vi.hoisted(() => {
  const stack = {
    worker: { closed: false },
    router: {},
    webRtcServer: {},
  };
  return {
    stack,
    createLabWorker: vi.fn(async () => stack),
    closeLabWorker: vi.fn(async () => undefined),
  };
});

vi.mock('../src/worker.js', () => ({
  createLabWorker: workerModule.createLabWorker,
  closeLabWorker: workerModule.closeLabWorker,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test('closes the Worker when HTTPS server construction throws', async () => {
  const { createLabServer } = await import('../src/lab-server.js');
  const tlsError = new Error('TLS construction failed');
  const createHttpsServer = vi.fn(() => {
    throw tlsError;
  });
  const createWithDependencies = createLabServer as unknown as (
    options: Parameters<typeof createLabServer>[0],
    dependencies: {
      createWorker: typeof workerModule.createLabWorker;
      closeWorker: typeof workerModule.closeLabWorker;
      createHttpsServer: typeof createHttpsServer;
    },
  ) => ReturnType<typeof createLabServer>;

  const error = await createWithDependencies(
    {
      port: 0,
      tls: { key: 'invalid', cert: 'invalid' },
    },
    {
      createWorker: workerModule.createLabWorker,
      closeWorker: workerModule.closeLabWorker,
      createHttpsServer,
    },
  ).then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(workerModule.closeLabWorker).toHaveBeenCalledOnce();
  expect(workerModule.closeLabWorker).toHaveBeenCalledWith(workerModule.stack);
  expect(createHttpsServer).toHaveBeenCalledOnce();
  expect(error).toBe(tlsError);
});
