import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'vendor/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/**/*.mjs', '*.mjs'], languageOptions: { globals: { process: 'readonly', fetch: 'readonly', console: 'readonly' } }, rules: { 'no-console': 'off' } },
  { rules: { 'no-console': 'error', '@typescript-eslint/no-explicit-any': 'error' } },
);
