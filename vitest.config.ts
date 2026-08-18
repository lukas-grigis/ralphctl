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
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**'],
      // Regression floors, measured 2026-08-17 with `src/application/ui/**` INCLUDED in
      // coverage — the exclude that used to hide the primary surface (TUI + CLI, 237 files)
      // is gone, so the whole tree now has a floor. Measured that day:
      //   whole tree  statements 87.27 · branches 77.16 · functions 91.46 · lines 90.06
      //   non-UI      statements 91.04 · branches 81.13 · functions 96.78 · lines 94.03
      //   UI          statements 81.25 · branches 71.31 · functions 84.24 · lines 83.69
      // Three tiers rather than one lowered global number: v8-over-Ink coverage is noisier
      // than pure logic, so the UI tier gets its own lower floor while the logic tier keeps
      // the strict floor it has always had (90/80/96/93 — unchanged).
      // NOTE: vitest applies the GLOBAL thresholds to every file even when glob keys are
      // present — the globs ADD floors, they do not partition — so the global row must be
      // the whole-tree number, not the non-UI one.
      // Glob matching is on the path relative to the vitest root, so the POSIX separators
      // below only match on POSIX runners; on Windows an empty coverage map reads as 100%,
      // i.e. the glob tiers degrade to vacuously-pass, never to a false failure. CI is ubuntu.
      // Raise these in lockstep with new tests; do NOT tighten retroactively in a commit
      // that isn't adding tests.
      thresholds: {
        statements: 86,
        branches: 75,
        functions: 90,
        lines: 88,
        '!src/application/ui/**': { statements: 90, branches: 80, functions: 96, lines: 93 },
        'src/application/ui/**': { statements: 79, branches: 69, functions: 82, lines: 82 },
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
          // Colour is PINNED, not inherited. Ink/chalk decide colour support from the worker's
          // env, and every TUI assertion is a plain-substring check against `lastFrame()` — with
          // an ambient `FORCE_COLOR` (Claude Code exports `FORCE_COLOR=3`; several terminal
          // wrappers and CI images do too) chalk splits those substrings with truecolor SGR codes
          // and 27 assertions across 13 files fail on a pristine tree. The suite must give the
          // same answer for every developer, agent session and runner, so the gate stays
          // trustworthy. `NO_COLOR` is deliberately NOT set here: chalk lets FORCE_COLOR win
          // anyway, and `useNoColor()` reads NO_COLOR to swap in the shape-glyph fallback —
          // pinning it suite-wide would silently run every test through the fallback path and
          // neuter `tasks-panel-no-color.test.tsx`, which sets it per-test on purpose.
          env: { FORCE_COLOR: '0' },
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
          // Same colour pin as the `tui` project — CLI-output assertions are plain-substring too.
          env: { FORCE_COLOR: '0' },
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
