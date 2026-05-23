import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ALIASES = {
  '@src': fileURLToPath(new URL('./src', import.meta.url)),
  '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
};

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/application/ui/**'],
      // Regression floor — set ~5% below the 2026-05-23 baseline so natural drift doesn't
      // fail CI but a real coverage drop does. Baseline measured at that date:
      //   statements 86.96 · branches 74.5 · functions 95.1 · lines 90.46.
      // Raise these in lockstep with new tests; do NOT tighten retroactively in a commit
      // that isn't adding tests.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 90,
        lines: 85,
      },
    },
    // Two projects so the heavy TUI render tests can run with file-level serialisation
    // while everything else keeps full fork-pool parallelism. The TUI suite is the only
    // one that legitimately needs CPU-stable timing: Ink reconciliation + sequential
    // keystroke flows are sensitive to fork contention, and turning that contention off
    // is cheaper than perpetually hunting flaky assertions. Other tests are pure logic
    // and parallelise cleanly.
    projects: [
      {
        resolve: { alias: ALIASES },
        test: {
          name: 'tui',
          include: ['tests/integration/application/ui/tui/**/*.test.{ts,tsx}'],
          pool: 'forks',
          // One file at a time within this project; non-TUI tests still parallelise.
          fileParallelism: false,
          // Even serial, individual TUI tests can take a couple of seconds (render +
          // multiple keystroke cycles + effect flushes). 15s gives plenty of margin.
          testTimeout: 15000,
        },
      },
      {
        resolve: { alias: ALIASES },
        test: {
          name: 'default',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: ['tests/integration/application/ui/tui/**'],
          pool: 'forks',
        },
      },
    ],
  },
});
