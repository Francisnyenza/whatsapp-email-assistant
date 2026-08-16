// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          // ADR 0002: secrets must never be logged, and encrypted fields must
          // never be read without going through the crypto package.
          selector:
            "MemberExpression[object.name='process'][property.name='env'] ~ CallExpression[callee.property.name='log']",
          message: 'Do not log process.env. Use the config service.',
        },
        {
          // Every worker call site used to name its adapter with the literal
          // 'gmail', because `ProviderAccount` did not carry the kind and there
          // was nothing else to pass. A Microsoft mailbox was operated through
          // the Gmail adapter with a Microsoft token on every operation, and
          // the Graph adapter — built, tested and marked shipped — was never
          // invoked at runtime.
          //
          // A test cannot catch this coming back: reverting one call site to
          // the literal passes the entire suite, because the integration tests
          // stub the provider and no suite exercises the wiring between an
          // account and its adapter. A lint rule can, and it reads every file.
          selector: "CallExpression[callee.property.name='providerFor'] > Literal:first-child",
          message:
            'Pass account.provider, never a literal. Hardcoding it routes every mailbox through one adapter.',
        },
      ],
    },
  },
  {
    // NestJS reads constructor parameter types at runtime via
    // emitDecoratorMetadata. Rewriting an injected class to `import type` erases
    // the runtime binding and the container fails with "can't resolve
    // dependencies" — at boot, in production, not in the type checker. The rule
    // is off for the API and worker so --fix cannot reintroduce it.
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Tests may reach for `any` and console output.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
