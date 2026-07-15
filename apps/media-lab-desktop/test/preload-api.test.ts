import { expect, test, vi } from 'vitest';

test('preload API is frozen and invokes only named allowlist channels', async () => {
  const { createMediaLabApi } = await import('../src/preload/api.js');
  const invoke = vi.fn().mockResolvedValue(undefined);
  const api = createMediaLabApi(invoke);

  await api.listSources();
  await api.selectSource('screen:1:0');
  await api.exportStats('[{"fps":60}]');

  expect(Object.keys(api)).toEqual([
    'listSources',
    'selectSource',
    'exportStats',
  ]);
  expect(Object.isFrozen(api)).toBe(true);
  expect(invoke.mock.calls).toEqual([
    ['media-lab:list-sources'],
    ['media-lab:select-source', 'screen:1:0'],
    ['media-lab:export-stats', '[{"fps":60}]'],
  ]);
});
