import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const enabled =
  process.platform === 'win32' &&
  process.env.WO_RUN_DESKTOP_E2E_INTEGRATION === '1';
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';

describe.skipIf(!enabled)(
  'desktop auth, room, and direct signaling integration',
  () => {
    test('passes the real two-Electron direct media path', () => {
      const result = spawnSync(
        pnpm,
        [
          '--filter',
          '@wo/desktop',
          'exec',
          'playwright',
          'test',
          'e2e/two-peer.spec.ts',
          '--config',
          'playwright.config.ts',
          '--grep',
          'real two-peer direct path',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: process.env,
          timeout: 360_000,
          windowsHide: true,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 370_000);
  },
);
