import { defineConfig } from 'tsup';
import { resolve } from 'node:path';

export default defineConfig({
  entry: { cli: 'src/application/entrypoint.ts' },
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.alias = { '@src': resolve('src') };
  },
});
