// Flat ESLint config (ESLint 9/10). Replaces .eslintrc.json.
// The rule set intentionally mirrors the previous eslintrc: no eslint:recommended
// preset, just the project's explicit rules — so baseline lint behavior is preserved.
import tseslintParser from '@typescript-eslint/parser'
import tseslintPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

// Core rules shared by JS and TS files (mirrors the old top-level "rules").
const commonRules = {
  'no-console': 'off',
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'prefer-const': 'warn',
  'no-var': 'error',
  'eqeqeq': ['warn', 'always'],
  'no-throw-literal': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error'
}

export default [
  // Global ignores (formerly "ignorePatterns" + the lint script's --ignore-pattern
  // flags + .eslintignore, which flat config does not read).
  { ignores: ['build/', 'dist/', 'dist-ssr/', 'node_modules/', 'coverage/', 'data/', 'logs/', '.qwen/', 'stats.html', '**/*.min.js'] },

  // Match the previous eslintrc behaviour: eslint 8 did not flag unused
  // eslint-disable directives, so keep that off to avoid new noise.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },

  // Plain JS / CJS / MJS files — node + browser globals.
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: { ...commonRules }
  },

  // TypeScript files — TS parser; swap the core no-unused-vars for the typed rule.
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslintParser,
      globals: { ...globals.node, ...globals.browser }
    },
    plugins: { '@typescript-eslint': tseslintPlugin },
    rules: {
      ...commonRules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },

  // React feature code — hooks + refresh rules (mirrors the old src/** override).
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'off'
    }
  }
]