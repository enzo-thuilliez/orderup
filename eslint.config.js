import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', 'coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['packages/web/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      '*.{js,ts}',
      'packages/{shared,server,cli}/**/*.{js,ts}',
      'packages/web/vite.config.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);
