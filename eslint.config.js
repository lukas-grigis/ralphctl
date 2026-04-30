import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
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
    ignores: ['dist/', 'node_modules/', 'coverage/', '*.config.js', '*.config.ts'],
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
