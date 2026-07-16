import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

const outputDirectory = fileURLToPath(new URL('../out', import.meta.url));

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function assertNoWorkspaceRuntimeImport(source, path) {
  const forbidden = [
    /@wo\/protocol/u,
    /packages[\\/]protocol[\\/]dist/u,
    /(?:from\s+|import\s*\(|require\s*\()\s*['"]zod(?:\/[^'"]*)?['"]/u,
  ];
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error(`Build contains a non-self-contained import: ${path}`);
  }
}

async function verifyRendererAssets(rendererDirectory) {
  const htmlPath = join(rendererDirectory, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const document = new JSDOM(html).window.document;
  const assets = [...document.querySelectorAll('[src], [href]')].map(
    (element) => element.getAttribute('src') ?? element.getAttribute('href'),
  );
  if (
    assets.length === 0 ||
    assets.some(
      (asset) =>
        typeof asset !== 'string' ||
        !asset.startsWith('./assets/') ||
        asset.includes('..'),
    )
  ) {
    throw new Error('Renderer contains a remote or invalid asset reference');
  }

  for (const path of await filesBelow(rendererDirectory)) {
    if (extname(path) !== '.css') continue;
    const css = await readFile(path, 'utf8');
    if (/url\(\s*['"]?(?:https?:|\/\/)/iu.test(css)) {
      throw new Error(`Renderer CSS contains a remote asset: ${path}`);
    }
  }
}

const runtimeDirectories = [
  join(outputDirectory, 'main'),
  join(outputDirectory, 'preload'),
];
for (const directory of runtimeDirectories) {
  for (const path of await filesBelow(directory)) {
    if (extname(path) !== '.js') continue;
    assertNoWorkspaceRuntimeImport(await readFile(path, 'utf8'), path);
  }
}
await verifyRendererAssets(join(outputDirectory, 'renderer'));

console.info('DESKTOP_BUILD_VERIFIED');
