import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('desktop LAN main-process wiring', () => {
  it('installs capture lifecycle with LAN shutdown after readiness', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );
    const ready = source.indexOf('app.whenReady()');
    const lifecycle = source.indexOf('installCaptureLifecycle({', ready);
    const stop = source.indexOf(
      'stopLanSession: () => stopLanSession()',
      lifecycle,
    );

    expect(source).toMatch(/\bpowerMonitor,\s*\n/u);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(lifecycle).toBeGreaterThan(ready);
    expect(stop).toBeGreaterThan(lifecycle);
  });
});
