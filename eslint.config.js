import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import-x';
import vitest from '@vitest/eslint-plugin';
import globals from 'globals';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.js', '*.config.ts', 'scripts/'],
  },
  // consistent-type-imports — `import type` for type-only imports keeps the
  // emitted JS small and clarifies intent. `separate-type-imports` keeps the
  // type and value imports as distinct statements (no `import { type X, y }`
  // mixes), which plays nicer with TS isolatedModules.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  // no-default-export — every export is named. Defaults are easy to rename at
  // import sites and harder to grep for. There are zero legitimate defaults in
  // this repo (no React component conventions that require it, no module that
  // ships a single value).
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'import-x': importPlugin },
    rules: {
      'import-x/no-default-export': 'error',
    },
  },
  // Path-alias enforcement — every import that crosses a directory
  // Cross-folder imports MUST use the `@src/*` alias (configured in
  // tsconfig's paths). Sibling imports (`./foo`) stay untouched.
  // Off-the-shelf ESLint plugins for this (eslint-plugin-no-relative-import-paths,
  // eslint-plugin-import-alias) are all stuck on deprecated
  // `context.getCwd()` / `context.getFilename()` APIs and crash on
  // ESLint 10. We use a plain syntax restriction instead — it doesn't
  // auto-fix, but the offending import is always a few characters away.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'import-x': importPlugin },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[source.value=/^\\.\\.\\//], ImportExpression[source.value=/^\\.\\.\\//]',
          message: 'Use the `@src/*` path alias instead of `../` relative imports.',
        },
      ],
    },
  },
  // vitest — guards against typical test-suite footguns: stray .only/.skip
  // committed by accident, malformed expects, and looser equality. Test files
  // only — production code never imports vitest.
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/__e2e__/**/*.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      'vitest/no-focused-tests': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/valid-expect': 'error',
      'vitest/prefer-strict-equal': 'warn',
    },
  },
  // React hooks — catches stale-closure bugs (e.g. useEffect with empty deps array
  // capturing a router or other reactive value). Pair: rules-of-hooks (correctness)
  // + exhaustive-deps (warning, since some patterns are intentional).
  {
    files: ['src/**/*.{tsx,ts}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // no-console — business/UI/integration code must route through LoggerPort.
  // Narrow exception: listener-error swallow files — pre-logger pub/sub
  // primitives must not route their own failures through the logger. They
  // use `console.warn` with an inline rationale comment.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'src/integration/signals/bus.ts',
      'src/integration/ui/prompts/prompt-queue.ts',
      'src/kernel/algorithms/rate-limit-coordinator.ts',
      'src/integration/logging/log-event-bus.ts',
      'src/kernel/runtime/chain-runner.ts',
      'src/application/runtime/session-manager.ts',
    ],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: [
      'src/integration/signals/bus.ts',
      'src/integration/ui/prompts/prompt-queue.ts',
      'src/kernel/algorithms/rate-limit-coordinator.ts',
      'src/integration/logging/log-event-bus.ts',
      'src/kernel/runtime/chain-runner.ts',
      'src/application/runtime/session-manager.ts',
    ],
    rules: {
      'no-console': ['error', { allow: ['warn'] }],
    },
  },
  // Clean Architecture layer fence (src/). Dependencies point inward only:
  //   kernel < domain < business < integration < application
  // Both kernel and domain are leaf-importable; business may import from either.
  {
    files: ['src/kernel/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/domain/**',
                '@src/domain/**',
                '**/business/**',
                '@src/business/**',
                '**/integration/**',
                '@src/integration/**',
                '**/application/**',
                '@src/application/**',
              ],
              message:
                'Kernel is the innermost, purest layer — it must not import from domain, business, integration, or application.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/business/**',
                '@src/business/**',
                '**/integration/**',
                '@src/integration/**',
                '**/application/**',
                '@src/application/**',
              ],
              message: 'Domain must not import from business, integration, or application. Kernel imports are allowed.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/business/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/integration/**', '@src/integration/**', '**/application/**', '@src/application/**'],
              message:
                'Business depends only on domain, kernel, and ports. Concrete adapters live in integration and must be injected, not imported.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/integration/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '@src/application/**'],
              message: 'Integration adapters must not import from application (the composition root).',
            },
          ],
        },
      ],
    },
  },
  // Workflow orchestration belongs to chain factories — CLI commands and TUI
  // views must launch refine/plan/ideate/execute/evaluate/feedback/onboard/
  // create-pr through `src/application/chains/`, never instantiate the
  // underlying multi-step use cases directly.
  //
  // CRUD use cases (sprint create/list/show/edit/remove, ticket CRUD, task
  // CRUD, project CRUD) are still callable directly — they're single-shot,
  // single-aggregate operations that don't need a chain wrapper.
  {
    files: ['src/application/cli/**/*.ts', 'src/application/tui/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/business/usecases/refine/*',
                '@src/business/usecases/refine/*',
                '**/business/usecases/plan/*',
                '@src/business/usecases/plan/*',
                '**/business/usecases/ideate/*',
                '@src/business/usecases/ideate/*',
                '**/business/usecases/execute/*',
                '@src/business/usecases/execute/*',
                '**/business/usecases/evaluate/*',
                '@src/business/usecases/evaluate/*',
                '**/business/usecases/feedback/*',
                '@src/business/usecases/feedback/*',
                '**/business/usecases/onboard/*',
                '@src/business/usecases/onboard/*',
                '**/business/usecases/sprint/create-pull-request*',
                '@src/business/usecases/sprint/create-pull-request*',
              ],
              message:
                'Workflow use cases must be invoked through chain factories (src/application/chains/), not instantiated directly. Type-only imports are allowed.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  }
);
