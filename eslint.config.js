// Lint rules for the whole template: TypeScript with type information, React hooks rules for the web app.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', 'certs/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.server.json', './tsconfig.web.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Numbers and booleans in messages are fine; objects are not (they print as [object Object]).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // `void promise` marks a deliberate fire-and-forget, as React handlers need.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // `return next(error)` and `return done(false)` end a function early; that is clear enough.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true, ignoreVoidReturningFunctions: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['server/**/*.ts', 'test/**/*.ts', 'eslint.config.js', 'web/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    // The two classic hooks rules. The plugin's React Compiler rules are left off: this app does not
    // use the compiler, and they forbid the "latest value in a ref" pattern it relies on.
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    // The store is one JSON document of records keyed by id: removing a record is deleting its key.
    files: ['server/store.ts'],
    rules: { '@typescript-eslint/no-dynamic-delete': 'off' },
  },
  {
    // Tests assert on loosely shaped JSON answers; reading them needs no ceremony.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Fakes implement async interfaces without awaiting anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
);
