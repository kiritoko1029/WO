import { describe, expect, test } from 'vitest';

describe('desktop capture source policy', () => {
  test('returns only a source enumerated and selected through the allowlist', async () => {
    const { CaptureSourceSelection } =
      await import('../src/main/capture-policy.js');
    const window = { id: 'window:1:0', name: 'Window 1' };
    const screen = { id: 'screen:1:0', name: 'Screen 1' };
    const selection = new CaptureSourceSelection();
    selection.replaceAvailable([window, screen]);

    expect(() => selection.select('window:999:0')).toThrow(/not enumerated/i);
    selection.select('screen:1:0');

    expect(selection.selectedForRequest()).toBe(screen);
  });

  test('clears a selection that disappears during refresh', async () => {
    const { CaptureSourceSelection } =
      await import('../src/main/capture-policy.js');
    const selection = new CaptureSourceSelection();
    selection.replaceAvailable([{ id: 'screen:1:0', name: 'Screen 1' }]);
    selection.select('screen:1:0');

    selection.replaceAvailable([{ id: 'screen:2:0', name: 'Screen 2' }]);

    expect(() => selection.selectedForRequest()).toThrow(/no capture source/i);
  });
});
