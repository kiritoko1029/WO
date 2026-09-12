import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

const execute = promisify(execFile);
const enabled = process.env.WO_DOCKER_ACME_TEST === '1';
const root = resolve(import.meta.dirname, '..', '..');

describe.skipIf(!enabled)('managed ACME with a real test authority', () => {
  test('issues through HTTP-01 and reloads HTTPS after a real ACME renewal', async () => {
    const project = `wo-acme-${randomUUID().slice(0, 8)}`;
    const composeArguments = [
      'compose',
      '--project-name',
      project,
      '-f',
      resolve(root, 'tests/fixtures/acme/compose.yaml'),
    ];
    const run = async (arguments_: string[], timeout = 120_000) => {
      const result = await execute(
        'docker',
        [...composeArguments, ...arguments_],
        { cwd: root, encoding: 'utf8', timeout, windowsHide: true },
      );
      return result.stdout.trim();
    };
    const certificateCommand = (command: string, timeout?: number) =>
      run(['exec', '-T', 'certificates', 'sh', '-c', command], timeout);
    const waitFor = async (probe: () => Promise<boolean>, label: string) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          if (await probe()) return;
        } catch {
          // Certificate publication and first HTTPS reload run independently.
        }
        await delay(2_000);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    try {
      await run(['up', '-d', '--pull', 'missing']);
      await waitFor(async () => {
        await certificateCommand('sh /opt/wo/certificates.sh --check');
        return true;
      }, 'ACME HTTP-01 issuance');
      const status = JSON.parse(
        await certificateCommand('cat /status/status.json'),
      );
      expect(status).toMatchObject({
        version: 1,
        mode: 'acme',
        state: 'ready',
        errorCode: null,
      });
      const firstGeneration = await certificateCommand(
        'readlink /certs/current',
      );
      // Fetch only the randomly generated public root over verified HTTPS.
      // Pebble's management root differs from its public API transport CA.
      await certificateCommand(
        'curl --fail --silent --show-error --cacert /test-ca/pebble-ca.pem https://pebble:15000/roots/0 --output /tmp/issuer.pem',
      );
      const tlsFingerprint = async () => {
        await certificateCommand(
          'openssl s_client -connect wo.acme.test:443 -servername wo.acme.test -verify_hostname wo.acme.test -verify_return_error -CAfile /tmp/issuer.pem </dev/null > /tmp/served.pem 2>/tmp/tls-diagnostics',
        );
        return certificateCommand(
          "openssl x509 -in /tmp/served.pem -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f'",
        );
      };
      await waitFor(
        async () => (await tlsFingerprint()) === firstGeneration.split('/')[1],
        'first trusted HTTPS certificate',
      );
      expect(
        await certificateCommand(
          'curl --fail --silent --show-error --cacert /tmp/issuer.pem https://wo.acme.test/',
        ),
      ).toContain('WO_ACME_HTTPS_OK');

      // Force a genuine second ACME order; authorization reuse is disabled in
      // the fixture so the second order also proves the HTTP challenge route.
      await certificateCommand(
        'sh /opt/wo/certificates.sh --renew-now',
        120_000,
      );
      const secondGeneration = await certificateCommand(
        'readlink /certs/current',
      );
      expect(secondGeneration).not.toBe(firstGeneration);
      await waitFor(
        async () => (await tlsFingerprint()) === secondGeneration.split('/')[1],
        'renewed certificate in the live HTTPS endpoint',
      );
      const currentStatus = JSON.parse(
        await certificateCommand('cat /status/status.json'),
      );
      expect(currentStatus.state).toBe('ready');
      expect(currentStatus.errorCode).toBeNull();
      const authorityLog = await run(['logs', '--no-color', 'pebble']);
      const challengeUrls = new Set(
        [
          ...authorityLog.matchAll(
            /Attempting to validate w\/ HTTP: (http:\/\/wo\.acme\.test:80\/\.well-known\/acme-challenge\/[A-Za-z0-9_-]+)/g,
          ),
        ].map((match) => match[1]),
      );
      expect(challengeUrls.size).toBe(2);
      expect(authorityLog.match(/Issued certificate serial/g)).toHaveLength(2);
      expect(authorityLog).not.toContain('Skipping challenge validation');
    } catch (error) {
      // Public status and service logs are safe diagnostics; the ACME account
      // volume and its private log are never copied into test output.
      const diagnostics = await run([
        'logs',
        '--no-color',
        '--tail',
        '40',
        'certificates',
        'caddy',
        'pebble',
      ]).catch(() => 'Service logs unavailable');
      throw new Error(`ACME integration failed:\n${diagnostics}`, {
        cause: error,
      });
    } finally {
      await run(['down', '-v', '--remove-orphans'], 60_000);
    }
  }, 360_000);
});
