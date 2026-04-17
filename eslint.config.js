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
  // Clean Architecture layer fence. Dependencies point inward only:
  //   domain < business < integration < application
  // Inner layers never import from outer layers. Applies to all code in `src/`
  // except test files, which are free to reach across layers for setup.
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
              message: 'Domain is the innermost layer — it must not import from business, integration, or application.',
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
                'Business depends only on domain + ports. Concrete adapters live in integration and must be injected, not imported.',
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
  // Architectural fence: CLI commands and TUI views must go through
  // pipeline factories, never import use cases directly. Use cases are
  // an implementation detail of the pipelines; the CLI/UI layer should
  // treat `src/application/factories.ts` as the public seam.
  {
    files: ['src/integration/cli/**/*.ts', 'src/integration/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/business/usecases/*', '@src/business/usecases/*'],
              message:
                'CLI commands and TUI views must call pipeline factories, not use cases directly. Import from @src/application/factories.ts instead.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  }
);
