import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

test('dedicated contract runner cannot silently pass without collecting tests', () => {
  const configuration = readFileSync(
    resolve(import.meta.dirname, '..', '..', 'vitest.root.contract.config.ts'),
    'utf8',
  );
  expect(configuration).toContain("'tests/contract/**'");
  expect(configuration).toContain('passWithNoTests: false');
  const packageJson = JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '..', '..', 'package.json'),
      'utf8',
    ),
  ) as { scripts?: Record<string, string> };
  expect(packageJson.scripts?.['test:contract']).toBe(
    'vitest run --config vitest.root.contract.config.ts',
  );
});
