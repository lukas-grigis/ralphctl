import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    // Default 5s/10s ceilings are tight when many tests run in parallel:
    // filesystem-bound tests (git operations, doctor checks that fan out to
    // `spawnSync` / `git` / `claude --version`) and Ink-based UI tests can
    // momentarily stall under contention. Bumping headroom here beats
    // scattering per-test overrides.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // Emit the report even when a test fails so threshold violations are visible
      // independently of pre-existing test failures.
      reportOnFailure: true,
      // Only gate on golden-path modules (project → sprint → ticket → refine → plan → exec).
      // Tests, TUI, CLI, and integration adapters are intentionally excluded so the bar
      // reflects business logic and domain coverage, not test-helper line counts.
      include: [
        'src/business/usecases/project/**',
        'src/business/usecases/sprint/**',
        'src/business/usecases/ticket/**',
        'src/business/usecases/refine/**',
        'src/business/usecases/plan/**',
        'src/business/usecases/execute/**',
        'src/business/usecases/evaluate/**',
        'src/application/chains/**',
        'src/domain/entities/**',
        'src/domain/values/**',
        'src/kernel/chain/**',
        'src/kernel/algorithms/**',
      ],
      exclude: ['**/*.test.ts', '**/*.test.tsx', '**/*.d.ts', '**/_test-fakes/**', '**/_test/**'],
      thresholds: {
        // Calibrated against measured golden-path coverage (2026-05-04):
        //   statements 86.52% · branches 73.85% · functions 95.92% · lines 90.61%
        // Set to the quality-sprint goal of 80% where headroom allows; branches
        // get a slightly lower floor (68%) because they are the weakest metric —
        // still a meaningful gate 5 pp below measured. Raise all values as
        // coverage improves; the declared goal is 80% across all four axes.
        lines: 80,
        branches: 68,
        functions: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@src': resolve(__dirname, './src'),
    },
  },
});
