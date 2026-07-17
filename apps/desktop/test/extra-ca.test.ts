import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installExtraCaFromEnvironment } from '../src/main/extra-ca.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('extra CA installation', () => {
  it('does nothing without an explicit certificate path', () => {
    const setDefaultCertificates = vi.fn();

    expect(installExtraCaFromEnvironment({}, { setDefaultCertificates })).toBe(
      false,
    );
    expect(setDefaultCertificates).not.toHaveBeenCalled();
  });

  it('appends valid PEM certificates to the existing defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wo-extra-ca-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'ca.pem');
    await writeFile(path, rootCertificates[0]!, 'utf8');
    const setDefaultCertificates = vi.fn();

    expect(
      installExtraCaFromEnvironment(
        { WO_EXTRA_CA_CERTS: path },
        {
          getDefaultCertificates: () => ['existing-ca'],
          setDefaultCertificates,
        },
      ),
    ).toBe(true);
    expect(setDefaultCertificates).toHaveBeenCalledWith([
      'existing-ca',
      rootCertificates[0],
    ]);
  });

  it('rejects relative paths and non-certificate contents', async () => {
    expect(() =>
      installExtraCaFromEnvironment({
        WO_EXTRA_CA_CERTS: 'relative/ca.pem',
      }),
    ).toThrow(/absolute file path/iu);

    const directory = await mkdtemp(join(tmpdir(), 'wo-extra-ca-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'ca.pem');
    await writeFile(path, 'not a certificate', 'utf8');

    expect(() =>
      installExtraCaFromEnvironment({ WO_EXTRA_CA_CERTS: path }),
    ).toThrow(/only certificates/iu);
  });
});
