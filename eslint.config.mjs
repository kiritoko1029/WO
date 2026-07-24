import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      '**/playwright-report/**',
      '**/release/**',
      '**/test-results/**',
      'docs/poc/results/**',
      'deploy/.certs/**',
      '.agents/**',
      '.claude/**',
      '.codex/**',
      '.cursor/**',
      '.gitnexus/**',
      '.pi/**',
      '.trellis/**',
      '.worktrees/**',
      '.zcode/**',
      'opendesign/**',
      'index-*.js',
      'outputs/**',
      'work/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'eslint.config.mjs',
      '**/*.{config,conf}.{js,cjs,mjs,ts,mts,cts}',
      '**/scripts/**/*.{js,cjs,mjs,ts,mts,cts}',
      'docs/poc/hardware-gate-harness.mjs',
      'docs/poc/hardware-gate-policy.mjs',
      'docs/poc/hardware-gate-motion-source/main.cjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['docs/poc/hardware-gate-motion-source/renderer.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['docs/poc/hardware-gate-motion-source/main.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
