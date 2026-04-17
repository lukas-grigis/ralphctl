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
