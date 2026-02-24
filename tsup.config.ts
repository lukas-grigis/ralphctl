import { defineConfig } from 'tsup';
import { resolve } from 'node:path';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  esbuildOptions(options) {
    options.alias = { '@src': resolve('src') };
  },
});
