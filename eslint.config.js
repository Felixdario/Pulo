import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.dupla/**',
      'packages/db/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/{redirect,api,worker}/**/*.ts', 'packages/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  prettier,
);
