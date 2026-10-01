// Default to React/Ink's production build before any part of the app graph is imported. A
// plain top-level statement can never run before a *static* import's module evaluation — ESM
// always evaluates an imported module (and its own top-level code) before the importing
// module's remaining body runs, regardless of textual order — so the CLI is loaded via a
// dynamic import() instead, which executes in place, after this line. Without this, a
// binary launched with no NODE_ENV set (the common case for an installed CLI) falls back to
// React's development build, which carries a diagnosed `performance.measure()` heap leak in
// Node's perf_hooks — long-running TUI sessions eventually OOM. `??=` only fills in a missing
// value: an explicit NODE_ENV (e.g. `pnpm dev` / `pnpm start`'s own NODE_ENV=production shell
// prefix, or a maintainer deliberately debugging with NODE_ENV=development) is left untouched.
process.env.NODE_ENV ??= 'production';

// chalk fixes its colour level when first imported, so the opt-out must land before the CLI graph loads.
const { isColorDisabled } = await import('@src/application/ui/tui/runtime/use-no-color.ts');
if (isColorDisabled()) process.env.FORCE_COLOR = '0';

const { runCli } = await import('@src/application/ui/cli/cli.ts');

await runCli(process.argv);
