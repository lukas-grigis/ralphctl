import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';

describe('loadTemplate', () => {
  let templatesDir: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-template-loader-'));
    const resolved = await realpath(raw);
    const parsed = AbsolutePath.parse(resolved);
    if (!parsed.ok) throw new Error('tmp dir not absolute');
    templatesDir = parsed.value;
    cleanup = async () => fs.rm(resolved, { recursive: true, force: true });
  });

  afterEach(async () => cleanup());

  it('reads a per-prompt template at <dir>/<name>/template.md', async () => {
    await fs.mkdir(join(String(templatesDir), 'greeting'));
    await fs.writeFile(join(String(templatesDir), 'greeting', 'template.md'), '# Hello {{NAME}}\n');

    const result = await createFsTemplateLoader(templatesDir).load('greeting');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('# Hello {{NAME}}\n');
  });

  it('falls back to <dir>/_partials/<name>.md when no per-prompt template exists', async () => {
    await fs.mkdir(join(String(templatesDir), '_partials'));
    await fs.writeFile(join(String(templatesDir), '_partials', 'harness-context.md'), 'shared partial');

    const result = await createFsTemplateLoader(templatesDir).load('harness-context');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('shared partial');
  });

  it('prefers the per-prompt template when both shapes exist', async () => {
    await fs.mkdir(join(String(templatesDir), 'refine'));
    await fs.writeFile(join(String(templatesDir), 'refine', 'template.md'), 'prompt body');
    await fs.mkdir(join(String(templatesDir), '_partials'));
    await fs.writeFile(join(String(templatesDir), '_partials', 'refine.md'), 'partial body');

    const result = await createFsTemplateLoader(templatesDir).load('refine');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('prompt body');
  });

  it('returns StorageError(io) with both candidate paths when neither shape exists', async () => {
    const result = await createFsTemplateLoader(templatesDir).load('missing');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(StorageError);
      expect(result.error.subCode).toBe('io');
      expect(result.error.message).toContain('missing/template.md');
      expect(result.error.message).toContain('_partials/missing.md');
    }
  });
});

describe('defaultTemplatesDir', () => {
  it('returns an absolute path that ends in /prompts', () => {
    const dir = defaultTemplatesDir();
    expect(String(dir)).toMatch(/\/prompts$/);
  });
});
