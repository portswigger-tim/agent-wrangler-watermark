import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { globals: globals.node }, rules: { 'no-unused-vars': ['error', { args: 'none' }] } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
];
