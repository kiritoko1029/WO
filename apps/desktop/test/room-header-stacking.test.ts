import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const stylesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/renderer/src/styles.css',
);

describe('room header stacking for share/quality popovers', () => {
  const css = readFileSync(stylesPath, 'utf8');

  it('keeps room-header above call-workspace and sizes menus to content', () => {
    expect(css).toMatch(
      /\.room-header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*20;[^}]*overflow:\s*visible;/s,
    );
    // Sibling workspace must not form a higher stacking context that steals
    // pointer events from absolute share/quality popovers under the header.
    expect(css).not.toMatch(/\.call-workspace\s*\{[^}]*z-index\s*:/s);
    expect(css).toMatch(
      /\.room-share-menu\s*\{[^}]*z-index:\s*30;[^}]*grid-auto-rows:\s*min-content;[^}]*height:\s*fit-content;/s,
    );
    expect(css).toMatch(
      /\.quality-panel\s*\{[^}]*z-index:\s*30;[^}]*height:\s*fit-content;/s,
    );
    expect(css).toMatch(/\.room-share-error:empty\s*\{\s*display:\s*none;/s);
    expect(css).not.toMatch(
      /\.room-share-error\s*\{[^}]*min-height:\s*18px;/s,
    );
  });
});
