// Must stay the first statement: with NODE_ENV unset, React/Ink load their dev build, whose leaked
// performance.measure() entries eventually OOM a long TUI session. ESM evaluates static imports before
// any of this body runs, so everything below is a dynamic import(). `??=` keeps an explicit NODE_ENV.
process.env.NODE_ENV ??= 'production';

// chalk fixes its colour level when first imported, so the opt-out must land before the CLI graph loads.
const { isColorDisabled } = await import('@src/application/ui/tui/runtime/use-no-color.ts');
if (isColorDisabled()) process.env.FORCE_COLOR = '0';

const { runCli } = await import('@src/application/ui/cli/cli.ts');

await runCli(process.argv);
