import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
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
  // Two narrow exceptions:
  //   1) Listener-error swallow files — pre-logger pub/sub primitives must not
  //      route their own failures through the logger. They use `console.warn`
  //      with an inline rationale comment.
  //   2) Plain-text CLI presentation (`theme/ui.ts`) — the canonical stdout
  //      formatter facade. `PlainTextSink` is layered on top of these
  //      formatters; this file IS the stdout boundary.
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
      'src/integration/ui/theme/ui.ts',
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
  {
    files: ['src/integration/ui/theme/ui.ts'],
    rules: {
      'no-console': ['error', { allow: ['log', 'error'] }],
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
