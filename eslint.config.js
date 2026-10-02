import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import importPlugin from 'eslint-plugin-import';
import playwright from 'eslint-plugin-playwright';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'playwright-report/**', 'test-results/**'] },

  js.configs.recommended,
  importPlugin.flatConfigs.recommended,
  prettier,

  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-fallthrough': 'off',
      'no-constant-condition': 'off',

      'import/first': 'error',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc', caseInsensitive: false },
          groups: [['builtin', 'external'], 'parent', ['sibling', 'index']],
          'newlines-between': 'always',
        },
      ],
      'import/newline-after-import': 'error',
      'import/no-duplicates': 'error',
      'import/no-mutable-exports': 'error',

      'no-useless-catch': 'off',
      'no-case-declarations': 'off',
      'no-unused-vars': 'warn',
      'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],

      /* Listed after prettier, which turns it off. */
      curly: ['error', 'all'],
    },
  },

  {
    files: ['**/*.e2e.js'],
    plugins: { playwright },
    rules: {
      'playwright/missing-playwright-await': 'error',
      'playwright/no-restricted-matchers': [
        'error',
        {
          toMatchSnapshot:
            '"toHaveScreenshot" assertions should be used in favor of "toMatchSnapshot". "toHaveScreenshot" brings file size reductions and anti-flake behaviors such as disabling animations by default.',
        },
      ],
    },
  },

  /* The client runs in the browser; the server, tests and config run in Node. */
  { files: ['src/client/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['src/*.mjs', 'test/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
];
