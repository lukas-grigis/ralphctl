// Default to React/Ink's production build before any part of the app graph is imported.
process.env.NODE_ENV ??= 'production';

// chalk fixes its colour level when first imported, so the opt-out must land before the CLI graph loads.
const { isColorDisabled } = await import('@src/application/ui/tui/runtime/use-no-color.ts');
if (isColorDisabled()) process.env.FORCE_COLOR = '0';

const { runCli } = await import('@src/application/ui/cli/cli.ts');

await runCli(process.argv);
