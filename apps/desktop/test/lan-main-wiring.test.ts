import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('desktop LAN main-process wiring', () => {
  it('stops the LAN service when the host suspends', async () => {
    const source = await readFile(
      new URL('../src/main/index.ts', import.meta.url),
      'utf8',
    );
    const ready = source.indexOf('app.whenReady()');
    const suspend = source.indexOf("powerMonitor.on('suspend'", ready);
    const stop = source.indexOf('void stopLanSession()', suspend);

    expect(source).toMatch(/\bpowerMonitor,\s*\n/u);
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(suspend).toBeGreaterThan(ready);
    expect(stop).toBeGreaterThan(suspend);
  });
});
