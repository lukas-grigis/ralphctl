import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';

/**
 * Filesystem-backed `TemplateLoader`. Resolves a template name to one of two on-disk shapes,
 * in this order:
 *
 *   1. `<dir>/<name>/template.md`     — per-prompt template (refine, plan, ideate, ...).
 *      Pairs with the `ai/prompts/<name>/definition.ts` so the template sits next to its
 *      definition — one folder per prompt.
 *   2. `<dir>/_partials/<name>.md`    — cross-cutting partial (harness-context, signals-task,
 *      signals-evaluation, validation-checklist). Underscore prefix keeps them sorted above
 *      the named prompts.
 *
 * The loader is plain — no built-in cache. Each call hits the filesystem; callers wrap with a
 * Map cache when a template is loaded multiple times within one chain run.
 */
export const createFsTemplateLoader = (templatesDir: AbsolutePath): TemplateLoader => ({
  async load(name: string): Promise<Result<string, StorageError>> {
    const promptPath = join(String(templatesDir), name, 'template.md');
    const partialPath = join(String(templatesDir), '_partials', `${name}.md`);

    const prompt = await tryRead(promptPath);
    if (prompt.kind === 'ok') return Result.ok(prompt.value);
    if (prompt.kind === 'error') return Result.error(prompt.error);

    const partial = await tryRead(partialPath);
    if (partial.kind === 'ok') return Result.ok(partial.value);
    if (partial.kind === 'error') return Result.error(partial.error);

    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `template not found: '${name}' (looked at ${promptPath} and ${partialPath})`,
        path: promptPath,
      })
    );
  },
});

type ReadOutcome =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly error: StorageError };

const tryRead = async (path: string): Promise<ReadOutcome> => {
  try {
    const content = await fs.readFile(path, 'utf8');
    return { kind: 'ok', value: content };
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return { kind: 'missing' };
    return {
      kind: 'error',
      error: new StorageError({ subCode: 'io', message: `read failed: ${path}`, path, cause }),
    };
  }
};

// fs-template-loader.ts lives at src/integration/ai/prompts/_engine/; templates sit one
// level up at src/integration/ai/prompts/<name>/template.md (and _partials/<name>.md).
// Resolved eagerly at module load so the invariant ("`import.meta.url` parent is an
// absolute path") is checked once at startup — there is no recoverable failure mode for
// callers, so we don't expose a Result.
const TEMPLATES_DIR: AbsolutePath = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, '..');
  const parsed = AbsolutePath.parse(path);
  if (!parsed.ok) {
    throw new Error(`fs-template-loader: bundled-templates path is not absolute: ${path}`);
  }
  return parsed.value;
})();

/**
 * Directory the bundled prompt templates live in. In dev (running via `tsx`) this resolves
 * to `src/integration/ai/prompts/`; published bundles can override by passing an explicit
 * path to {@link createFsTemplateLoader}.
 */
export const defaultTemplatesDir = (): AbsolutePath => TEMPLATES_DIR;

const isNodeErrnoCode = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
