import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';

/**
 * `TemplateLoader` — loads `.md` prompt templates from disk.
 *
 * The default lookup performs a dev-vs-bundled resolution mirroring the
 * legacy loader:
 *  - When running from `src/` (dev / tsx), templates live in
 *    `src/integration/ai/prompts/templates/`.
 *  - When running from `dist/` (the published bundle), the build script
 *    copies the templates into `dist/prompts/`.
 *
 * The resolved path is selected once at construction by probing
 * `dist/prompts/` first (`existsSync`) and falling back to the dev
 * sibling. Tests override the seam with the `templatesDir` option so
 * they can stage a fixture directory.
 */
export interface TemplateLoader {
  /** Load a template by base name (without `.md`). */
  load(name: string): Promise<Result<string, StorageError>>;
}

export interface FileTemplateLoaderOptions {
  /**
   * Override the directory templates are read from. When provided, the
   * dev/dist auto-detection is bypassed — useful for tests and any
   * caller that wants to ship a custom template set.
   */
  readonly templatesDir?: AbsolutePath;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the directory templates live in. Public so the prompt builder
 * adapter and tests can verify the same logic that {@link FileTemplateLoader}
 * uses internally.
 */
export function defaultTemplatesDir(): AbsolutePath {
  // In the published bundle, `HERE` is `dist/` (tsup flattens the tree)
  // and the build step copies templates into `dist/prompts/`. In dev,
  // `HERE` is `src/integration/ai/prompts/` and the templates sit
  // right next to this loader under `templates/`.
  const distSibling = join(HERE, 'prompts');
  if (existsSync(distSibling)) return AbsolutePath.trustString(distSibling);
  return AbsolutePath.trustString(join(HERE, 'templates'));
}

export class FileTemplateLoader implements TemplateLoader {
  private readonly templatesDir: AbsolutePath;
  private readonly cache = new Map<string, string>();

  constructor(opts: FileTemplateLoaderOptions = {}) {
    this.templatesDir = opts.templatesDir ?? defaultTemplatesDir();
  }

  async load(name: string): Promise<Result<string, StorageError>> {
    const cached = this.cache.get(name);
    if (cached !== undefined) return Result.ok(cached);

    const path = join(this.templatesDir, `${name}.md`);
    try {
      const content = await readFile(path, 'utf-8');
      this.cache.set(name, content);
      return Result.ok(content);
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : undefined;
      const message =
        code === 'ENOENT'
          ? `prompt template not found: ${name}.md (looked in ${this.templatesDir})`
          : `failed to read prompt template ${name}.md: ${err instanceof Error ? err.message : String(err)}`;
      return Result.error(
        new StorageError({
          subCode: 'io',
          message,
          path,
          cause: err,
        })
      );
    }
  }
}
