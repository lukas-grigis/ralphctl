import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Default 5s/10s ceilings are tight when ~1700 tests run in parallel:
    // filesystem-bound tests (git operations, doctor checks that fan out to
    // `spawnSync` / `git` / `claude --version`) and Ink-based UI tests can
    // momentarily stall under contention. Bumping headroom here beats
    // scattering per-test overrides.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
  resolve: {
    alias: {
      '@src': resolve(__dirname, './src'),
    },
  },
});
