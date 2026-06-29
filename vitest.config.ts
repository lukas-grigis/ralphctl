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
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/application/ui/**'],
      // Regression floor — set ~1% below the 2026-05-26 baseline (post the F1 business-layer
      // unit-test density lift). Baseline measured at that date:
      //   statements 87.87 · branches 75.91 · functions 95.47 · lines 91.38.
      // Raise these in lockstep with new tests; do NOT tighten retroactively in a commit
      // that isn't adding tests.
      thresholds: {
        statements: 87,
        branches: 75,
        functions: 95,
        lines: 90,
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
          // E2E tests under `tests/e2e/cli/` spawn real child processes (git / gh / glab /
          // provider CLIs) inside the in-process CLI run, and pay full module-import cost on
          // a cold `node_modules` (Cold-install smoke job). Vitest's implicit 5 s default
          // budget is too tight for that, and the resulting test-timeout failures masquerade
          // as logic flakes. 15 s matches the `tui` project; raise here in lockstep with it.
          testTimeout: 15000,
        },
      },
    ],
  },
});
