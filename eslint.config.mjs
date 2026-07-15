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
      '.worktrees/**',
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
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
);
