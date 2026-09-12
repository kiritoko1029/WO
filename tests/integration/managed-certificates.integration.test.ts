import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const enabled = process.env.WO_DOCKER_CERTIFICATE_TEST === '1';
const root = resolve(import.meta.dirname, '..', '..');
const image =
  'neilpang/acme.sh@sha256:5e5713c64816ca2f2dde780df87bc7464e6f6a5995d457710131b688317b8352';

describe.skipIf(!enabled)('managed certificate container', () => {
  test('validates, rotates and protects the last working certificate', () => {
    const name = `wo-certificate-probe-${randomUUID()}`;
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
          '--read-only',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--cap-add',
          'FOWNER',
          '--cap-add',
          'DAC_OVERRIDE',
          '--security-opt',
          'no-new-privileges:true',
          ...['/acme.sh', '/certs', '/status', '/var/www/acme', '/tmp'].flatMap(
            (directory) => [
              '--tmpfs',
              `${directory}:rw,${directory === '/tmp' ? 'exec' : 'noexec'},nosuid,nodev,size=16m`,
            ],
          ),
          '--mount',
          `type=bind,src=${resolve(root, 'deploy/managed/certificates/entrypoint.sh')},dst=/opt/wo/certificates.sh,readonly`,
          '--mount',
          `type=bind,src=${resolve(root, 'tests/fixtures/managed-certificates-probe.sh')},dst=/opt/wo/probe.sh,readonly`,
          '--entrypoint',
          'sh',
          image,
          '/opt/wo/probe.sh',
        ],
        { encoding: 'utf8', timeout: 90_000, windowsHide: true },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (const marker of [
        'INITIAL_FAILURE_STATUS_OK',
        'ISSUANCE_PERMISSIONS_OK',
        'ROTATION_PRESERVES_GENERATIONS_OK',
        'IDEMPOTENT_RESTART_OK',
        'CONCURRENT_WRITER_REJECTED_OK',
        'INVALID_EXPORT_PRESERVES_CERTIFICATE_OK',
      ]) {
        expect(result.stdout).toContain(marker);
      }
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('PRIVATE KEY');
    } finally {
      spawnSync('docker', ['rm', '-f', name], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
    }
  }, 110_000);
});
