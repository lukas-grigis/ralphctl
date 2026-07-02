import { defineConfig } from 'tsup';
import { resolve } from 'node:path';

export default defineConfig({
  entry: { cli: 'src/index.ts' },
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  // Code-splitting stays ON (tsup/esbuild's default for this shape) — required for the
  // NODE_ENV default-fill in `src/index.ts` to actually take effect. React/Ink are external
  // (not bundled), so their `import` statements are only deferred if the dynamic import() in
  // index.ts produces a genuinely separate output chunk; disabling splitting flattens
  // everything into one file, which hoists react/ink's external imports to the top of THAT
  // file — ahead of index.ts's own top-level code — and defeats the ordering `??=` relies on.
  // `bin` still resolves fine: `dist/cli.mjs` dynamically imports its sibling chunk file, both
  // published under `"files": ["dist/"]`.
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.alias = {
      '@src': resolve('src'),
      '@tests': resolve('tests'),
    };
    // NOTE: do not add a `process.env.NODE_ENV` `define` here. React/Ink are resolved as
    // external `import`s (not bundled), so esbuild's `define` never reaches their internal
    // dev-vs-prod branch — and applying it here would also rewrite the literal
    // `process.env.NODE_ENV` text in our own compiled src/index.ts into a constant,
    // corrupting the runtime `??=` assignment that is the actual fix (see src/index.ts).
  },
});
