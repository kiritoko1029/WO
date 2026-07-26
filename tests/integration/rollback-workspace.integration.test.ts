import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { releaseRollbackWorkspace } from '../../deploy/scripts/upgrade.mjs';

const enabled = process.env.WO_RUN_ROLLBACK_RESTART_INTEGRATION === '1';
const image = process.env.WO_ROLLBACK_TEST_IMAGE ?? 'alpine:3.21';

function docker(arguments_: string[]) {
  return spawnSync('docker', arguments_, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe.skipIf(!enabled)('rollback workspace container restart safety', () => {
  test('keeps coturn-style bind snapshots available across a Docker restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'wo-rollback-restart-'));
    const workspace = await mkdtemp(resolve(root, 'wo-upgrade-'));
    const snapshot = resolve(workspace, 'turnserver.rollback.conf');
    const container = `wo-rollback-restart-${randomUUID()}`;
    await writeFile(snapshot, 'rollback-config\n', { mode: 0o600 });

    try {
      const started = docker([
        'run',
        '--detach',
        '--name',
        container,
        '--mount',
        `type=bind,source=${snapshot},target=/etc/turnserver.rollback.conf,readonly`,
        image,
        'sh',
        '-c',
        'while :; do sleep 3600; done',
      ]);
      expect(started.stderr).toBe('');
      expect(started.status).toBe(0);

      await expect(releaseRollbackWorkspace(workspace, true)).resolves.toBe(
        false,
      );
      await expect(access(snapshot)).resolves.toBeUndefined();

      const restarted = docker(['restart', container]);
      expect(restarted.stderr).toBe('');
      expect(restarted.status).toBe(0);

      const mounted = docker([
        'exec',
        container,
        'cat',
        '/etc/turnserver.rollback.conf',
      ]);
      expect(mounted.stderr).toBe('');
      expect(mounted.status).toBe(0);
      expect(mounted.stdout).toBe('rollback-config\n');
    } finally {
      docker(['rm', '--force', container]);
      await rm(root, { force: true, recursive: true });
    }
  }, 45_000);
});
