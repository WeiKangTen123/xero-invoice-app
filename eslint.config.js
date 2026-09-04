const globals = require('globals');
const reactHooks = require('eslint-plugin-react-hooks');

// The rule that matters here is no-undef.
//
// A blank page reached production because Invoices.jsx called useMemo while
// importing only useState and useEffect. vite bundles a free identifier without
// complaint, the build was green, the whole suite was green, and the app threw
// ReferenceError on first render. A passing build proves the syntax parses and
// the modules resolve — nothing about whether the page runs.
//
// This is deliberately narrow. It is not a style pass and it does not enforce
// formatting: every rule below catches something that would break at runtime or
// hide a real mistake, so a failure always means something rather than being
// noise to argue with.
module.exports = [
  {
    ignores: [
      'node_modules/**', 'ui/node_modules/**', 'ui/dist/**',
      'main/data/**', 'logs/**', 'coverage/**',
      'prototype/**', 'report/**',
    ],
  },

  // Server: CommonJS, Node globals.
  {
    files: ['main/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      'no-undef': 'error',
      // Args are frequently there for signature shape; unused CATCH bindings are
      // idiomatic here and already reviewed.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-dupe-class-members': 'error',
      'no-self-compare': 'error',
      // An await inside a loop is sometimes exactly what is wanted (rate limits),
      // so it is not flagged.
    },
  },

  // UI: ES modules, browser globals, JSX.
  {
    files: ['ui/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    // The codebase already carries react-hooks/exhaustive-deps disable comments,
    // which ESLint 9 treats as an error when the rule is not defined. Installing
    // the plugin makes those comments mean something again, and rules-of-hooks
    // catches a class of bug that is invisible until it misbehaves at runtime.
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-undef': 'error',
      'react-hooks/rules-of-hooks': 'error',
      // Advisory: the existing disables were deliberate choices, not oversights.
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_|^React$' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
    },
  },
];
