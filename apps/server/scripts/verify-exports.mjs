import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
assert.equal(packageJson.exports?.['./lite']?.import, './dist/lite/index.js');
assert.equal(packageJson.exports?.['./lite']?.types, './dist/lite/index.d.ts');

const lite = await import('@wo/server/lite');
assert.equal(typeof lite.startLiteRoomService, 'function');
assert.equal(typeof lite.createLanFrameCodec, 'function');
