import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { managedProcessEnvironment } from '../../deploy/scripts/setup.mjs';

const enabled = process.env.WO_MANAGED_SECRET_TEST === '1';
const ownerLabel = 'io.wo.test.secret-permissions';
const cases = [
  {
    service: 'server',
    image: 'wo-server:integration',
    capabilities: ['SETUID', 'SETGID', 'SETPCAP'],
    uid: 1000,
    gid: 1000,
    dropCommand:
      '/usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups ' +
      '--no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all',
  },
  {
    service: 'coturn',
    image: 'wo-coturn:integration',
    capabilities: ['CHOWN', 'SETUID', 'SETGID', 'SETPCAP'],
    uid: 65534,
    gid: 65533,
    dropCommand: '/usr/local/bin/wo-drop-privileges 65534 65533',
  },
];

// Existing built images only: this probe never builds, pulls, publishes ports,
// mounts a Docker socket or touches a deployment's containers or secret files.
describe.skipIf(!enabled)('managed Linux secret permissions', () => {
  test.each(cases)(
    '$service reads a non-root 0600 secret only during privileged initialization',
    ({ service, image, capabilities, uid, gid, dropCommand }) => {
      const token = randomUUID();
      const volume = `wo-secret-permissions-${token}`;
      const label = `${ownerLabel}=${token}`;
      let containerIndex = 0;
      let volumeCreated = false;
      let operationFailed = false;
      let operationError: unknown;
      let cleanupFailed = false;
      let cleanupError: unknown;

      const docker = (args: string[]) =>
        spawnSync('docker', args, {
          encoding: 'utf8',
          env: managedProcessEnvironment(args),
          timeout: 20_000,
          windowsHide: true,
        });
      const requireSuccess = (args: string[]): string => {
        const result = docker(args);
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        return result.stdout.trim();
      };

      try {
        // Pin the already-built image ID so parallel builds cannot change the
        // dropper between the denied/readable/final-privilege observations.
        const imageId = requireSuccess([
          'image',
          'inspect',
          '--format',
          '{{.Id}}',
          image,
        ]);
        expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/u);
        const created = requireSuccess([
          'volume',
          'create',
          '--label',
          label,
          volume,
        ]);
        volumeCreated = true;
        expect(created).toBe(volume);

        const run = (caps: string[], writable: boolean, script: string) => [
          'run',
          '--rm',
          '--pull=never',
          '--name',
          `${volume}-${service}-${containerIndex++}`,
          '--label',
          label,
          '--network',
          'none',
          '--read-only',
          '--user',
          '0:0',
          '--cap-drop',
          'ALL',
          ...caps.flatMap((capability) => ['--cap-add', capability]),
          '--security-opt',
          'no-new-privileges:true',
          '--mount',
          `type=volume,source=${volume},target=/fixture${writable ? '' : ',readonly'}`,
          '--entrypoint',
          '/bin/sh',
          imageId,
          '-c',
          script,
        ];

        expect(
          requireSuccess(
            run(
              ['CHOWN'],
              true,
              'set -eu; printf synthetic-probe-only > /fixture/secret; ' +
                'chmod 600 /fixture/secret; chown 1000:1000 /fixture/secret; ' +
                'stat -c "%u:%g %a" /fixture/secret',
            ),
          ),
        ).toBe('1000:1000 600');

        const denied = docker(
          run(capabilities, false, 'cat /fixture/secret > /dev/null'),
        );
        expect(denied.error).toBeUndefined();
        expect(denied.status).toBe(1);
        expect(denied.stderr).toContain('Permission denied');

        const finalStatus = requireSuccess(
          run(
            [...capabilities, 'DAC_READ_SEARCH'],
            false,
            'set -eu; cat /fixture/secret > /dev/null; ' +
              `exec ${dropCommand} /bin/cat /proc/1/status`,
          ),
        );
        const fields = Object.fromEntries(
          finalStatus.split('\n').map((line) => {
            const separator = line.indexOf(':');
            return [line.slice(0, separator), line.slice(separator + 1).trim()];
          }),
        );
        expect(fields.Uid.split(/\s+/u)).toEqual(Array(4).fill(String(uid)));
        expect(fields.Gid.split(/\s+/u)).toEqual(Array(4).fill(String(gid)));
        expect(fields.Groups).toBe('');
        expect(fields.NoNewPrivs).toBe('1');
        for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
          expect(fields[field], field).toBe('0000000000000000');
      } catch (error) {
        operationFailed = true;
        operationError = error;
      } finally {
        try {
          // --rm handles successful runs; the exact random label also catches
          // a leftover container if the client times out during a failed run.
          const remaining = requireSuccess([
            'ps',
            '--all',
            '--quiet',
            '--filter',
            `label=${label}`,
          ]);
          for (const container of remaining.split(/\r?\n/u).filter(Boolean)) {
            expect(container).toMatch(/^[a-f0-9]{12,64}$/u);
            requireSuccess(['rm', '--force', container]);
          }
          if (volumeCreated) {
            expect(
              requireSuccess([
                'volume',
                'inspect',
                '--format',
                `{{ index .Labels "${ownerLabel}" }}`,
                volume,
              ]),
            ).toBe(token);
            requireSuccess(['volume', 'rm', volume]);
          }
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
      if (operationFailed && cleanupFailed)
        throw new AggregateError(
          [operationError, cleanupError],
          'Permission probe failed and its resources could not be cleaned',
          { cause: operationError },
        );
      if (operationFailed) throw operationError;
      if (cleanupFailed) throw cleanupError;
    },
    90_000,
  );
});
