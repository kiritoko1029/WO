import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
describe.skipIf(process.env.WO_DOCKER_APT_TEST !== '1')(
  'Debian package installer recovery',
  () => {
    test('rejects partial indexes, switches mirrors and keeps snapshot builds pinned', () => {
      const name = `wo-apt-probe-${randomUUID()}`;
      try {
        const result = spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            name,
            '--network',
            'none',
            '--mount',
            `type=bind,src=${resolve(root, 'deploy/scripts/install-debian-packages.sh')},dst=/installer.sh,readonly`,
            '--mount',
            `type=bind,src=${resolve(root, 'tests/fixtures/debian-packages-probe.sh')},dst=/probe.sh,readonly`,
            'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d',
            'sh',
            '/probe.sh',
          ],
          { encoding: 'utf8', timeout: 60_000, windowsHide: true },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
        for (const marker of [
          'MIRROR_FAILURE_RECOVERY_OK',
          'INCOMPLETE_INDEX_REJECTED_OK',
          'SNAPSHOT_FAILS_WITHOUT_MUTABLE_FALLBACK_OK',
          'SNAPSHOT_INSTALL_OK',
        ]) {
          expect(result.stdout).toContain(marker);
        }
      } finally {
        spawnSync('docker', ['rm', '-f', name], {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
        });
      }
    }, 75_000);
  },
);
