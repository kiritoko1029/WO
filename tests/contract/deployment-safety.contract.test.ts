import { gzipSync } from 'node:zlib';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  checkBackupDirectory,
  checkPortConflicts,
  integrationEdgePorts,
} from '../../deploy/scripts/preflight.mjs';
import { inspectCaddyArchive } from '../../deploy/scripts/restore.mjs';
import { postgresMajorFromImage } from '../../deploy/scripts/upgrade.mjs';

const temporaryDirectories: string[] = [];

function tarHeader(name: string, type: '0' | '2' | '5', size = 0): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000700\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

async function archive(entries: Array<[string, '0' | '2' | '5']>) {
  const directory = await mkdtemp(resolve(tmpdir(), 'wo-archive-test-'));
  temporaryDirectories.push(directory);
  const file = resolve(directory, 'archive.tgz');
  const tar = Buffer.concat([
    ...entries.map(([name, type]) => tarHeader(name, type)),
    Buffer.alloc(1024),
  ]);
  await writeFile(file, gzipSync(tar));
  return file;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe('deployment filesystem safety', () => {
  test('parses only explicit PostgreSQL image majors', () => {
    expect(postgresMajorFromImage('postgres:17.10-alpine3.23')).toBe(17);
    expect(() => postgresMajorFromImage('postgres:latest')).toThrow(/major/i);
  });

  test('rejects an unbounded port plan before allocating its relay range', async () => {
    await expect(
      checkPortConflicts({
        TURN_PORT: '3478',
        TURN_TLS_PORT: '5349',
        TURN_RELAY_MIN_PORT: '1',
        TURN_RELAY_MAX_PORT: '4294967295',
      }),
    ).resolves.toEqual([
      'Port conflict check requires a valid bounded TURN port plan',
    ]);
  });

  test('checks effective integration edge ports with shell precedence', async () => {
    expect(
      integrationEdgePorts(
        {
          WO_INTEGRATION_HTTP_PORT: '18080',
          WO_INTEGRATION_HTTPS_PORT: '18443',
        },
        { WO_INTEGRATION_HTTPS_PORT: '19443' },
      ),
    ).toEqual({ httpPort: '18080', httpsPort: '19443' });
    expect(
      integrationEdgePorts(
        { WO_INTEGRATION_HTTP_PORT: '18080' },
        { WO_INTEGRATION_HTTP_PORT: '' },
      ),
    ).toEqual({ httpPort: '80', httpsPort: '443' });
    await expect(
      checkPortConflicts(
        {
          TURN_PORT: '3478',
          TURN_TLS_PORT: '5349',
          TURN_RELAY_MIN_PORT: '49160',
          TURN_RELAY_MAX_PORT: '49200',
        },
        '127.0.0.1',
        { httpPort: 'invalid', httpsPort: '18443' },
      ),
    ).resolves.toEqual([
      'Port conflict check requires valid HTTP and HTTPS ports',
    ]);
  });

  test('accepts a provisioned backup directory without changing its mode', async () => {
    const root = await mkdtemp(
      resolve(await realpath(tmpdir()), 'wo-backup-test-'),
    );
    temporaryDirectories.push(root);
    const directory = resolve(root, 'backups');
    await mkdir(directory, { mode: 0o755 });
    expect(
      await checkBackupDirectory(directory, { minimumFreeBytesRequired: 0 }),
    ).toEqual([]);
  });

  test('rejects dangerous and symbolic-link backup directories', async () => {
    const root = await mkdtemp(
      resolve(await realpath(tmpdir()), 'wo-backup-test-'),
    );
    temporaryDirectories.push(root);
    const target = resolve(root, 'target');
    const link = resolve(root, 'link');
    await mkdir(target);
    await symlink(
      target,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(
      (await checkBackupDirectory(link, { minimumFreeBytesRequired: 0 })).join(
        '\n',
      ),
    ).toMatch(/symbolic link/i);
    expect(
      (
        await checkBackupDirectory(resolve(import.meta.dirname, '..', '..'), {
          minimumFreeBytesRequired: 0,
        })
      ).join('\n'),
    ).toMatch(/dangerous/i);
  });

  test('accepts only regular caddy files and directories in restore archives', async () => {
    await expect(
      inspectCaddyArchive(
        await archive([
          ['caddy/', '5'],
          ['caddy/certificates.json', '0'],
        ]),
      ),
    ).resolves.toBeUndefined();
    await expect(
      inspectCaddyArchive(await archive([['../outside', '0']])),
    ).rejects.toThrow(/path/i);
    await expect(
      inspectCaddyArchive(await archive([['caddy/link', '2']])),
    ).rejects.toThrow(/type/i);
  });
});
