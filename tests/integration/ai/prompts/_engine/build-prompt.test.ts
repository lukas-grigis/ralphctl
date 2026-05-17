import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { buildPrompt } from '@src/integration/ai/prompts/_engine/build-prompt.ts';
import type { PromptDefinition } from '@src/integration/ai/prompts/_engine/definition.ts';
import { createFsTemplateLoader } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';

interface SimpleParams {
  readonly name: string;
  readonly note?: string;
}

const simpleDef: PromptDefinition<SimpleParams> = {
  templateName: 'greeting',
  description: 'Greet someone with an optional note',
  parameters: {
    name: {
      placeholder: 'NAME',
      description: 'Person to greet',
      validate: (v: string) =>
        v.trim().length === 0
          ? Result.error(new ValidationError({ field: 'name', value: v, message: 'name must not be empty' }))
          : Result.ok(v),
    },
    note: {
      placeholder: 'NOTE',
      description: 'Optional note',
      optional: true,
    },
  },
  expectedSignals: [],
};

describe('buildPrompt — happy path', () => {
  let dir: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-build-prompt-'));
    const resolved = await realpath(raw);
    const parsed = AbsolutePath.parse(resolved);
    if (!parsed.ok) throw new Error('tmp dir not absolute');
    dir = parsed.value;
    cleanup = async () => fs.rm(resolved, { recursive: true, force: true });
  });

  afterEach(async () => cleanup());

  const writePromptTemplate = async (root: AbsolutePath, name: string, body: string): Promise<void> => {
    await fs.mkdir(join(String(root), name), { recursive: true });
    await fs.writeFile(join(String(root), name, 'template.md'), body);
  };

  const writePartial = async (root: AbsolutePath, name: string, body: string): Promise<void> => {
    await fs.mkdir(join(String(root), '_partials'), { recursive: true });
    await fs.writeFile(join(String(root), '_partials', `${name}.md`), body);
  };

  it('substitutes parameters and brands the result as Prompt', async () => {
    await writePromptTemplate(dir, 'greeting', 'Hello {{NAME}}.{{NOTE}}\n');

    const result = await buildPrompt(createFsTemplateLoader(dir), simpleDef, { name: 'Ada', note: ' (note)' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('Hello Ada. (note)\n');
  });

  it('treats an omitted optional parameter as empty string', async () => {
    await writePromptTemplate(dir, 'greeting', 'Hello {{NAME}}.{{NOTE}}\n');

    const result = await buildPrompt(createFsTemplateLoader(dir), simpleDef, { name: 'Ada' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('Hello Ada.\n');
  });

  it('auto-loads partials and substitutes them by placeholder', async () => {
    await writePromptTemplate(dir, 'greeting', '{{HARNESS}}\n\nHello {{NAME}}.{{NOTE}}\n');
    await writePartial(dir, 'harness-context', '<harness-context>\nctx\n</harness-context>\n');

    const defWithPartial: PromptDefinition<SimpleParams> = {
      ...simpleDef,
      partials: { HARNESS: 'harness-context' },
    };
    const result = await buildPrompt(createFsTemplateLoader(dir), defWithPartial, { name: 'Ada' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('<harness-context>\nctx\n</harness-context>');
      expect(result.value).toContain('Hello Ada.');
    }
  });
});

describe('buildPrompt — error paths', () => {
  let dir: AbsolutePath;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-build-prompt-err-'));
    const resolved = await realpath(raw);
    const parsed = AbsolutePath.parse(resolved);
    if (!parsed.ok) throw new Error('tmp dir not absolute');
    dir = parsed.value;
    cleanup = async () => fs.rm(resolved, { recursive: true, force: true });
  });

  afterEach(async () => cleanup());

  const writePromptTemplate = async (root: AbsolutePath, name: string, body: string): Promise<void> => {
    await fs.mkdir(join(String(root), name), { recursive: true });
    await fs.writeFile(join(String(root), name, 'template.md'), body);
  };

  it('returns ValidationError when a required parameter is missing', async () => {
    await writePromptTemplate(dir, 'greeting', '{{NAME}}\n');
    const result = await buildPrompt(createFsTemplateLoader(dir), simpleDef, {} as SimpleParams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect((result.error as ValidationError).field).toBe('name');
    }
  });

  it("returns ValidationError when the spec's validate rejects the value", async () => {
    await writePromptTemplate(dir, 'greeting', '{{NAME}}\n');
    const result = await buildPrompt(createFsTemplateLoader(dir), simpleDef, { name: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect((result.error as ValidationError).message).toContain('name must not be empty');
    }
  });

  it('returns StorageError when the template file is missing', async () => {
    const result = await buildPrompt(createFsTemplateLoader(dir), simpleDef, { name: 'Ada' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(StorageError);
  });

  it('returns StorageError when an auto-loaded partial is missing', async () => {
    await writePromptTemplate(dir, 'greeting', '{{HARNESS}}\n{{NAME}}\n');
    const defWithPartial: PromptDefinition<SimpleParams> = {
      ...simpleDef,
      partials: { HARNESS: 'missing-partial' },
    };
    const result = await buildPrompt(createFsTemplateLoader(dir), defWithPartial, { name: 'Ada' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(StorageError);
  });

  it('returns ParseError when the template carries a placeholder the manifest does not declare', async () => {
    // Template references {{UNKNOWN}} but the def has no spec for it — drift detected at the
    // assertFullySubstituted fence.
    await writePromptTemplate(dir, 'greeting', '{{NAME}} {{UNKNOWN}}\n');
    const result = await buildPrompt(createFsTemplateLoader(dir), simpleDef, { name: 'Ada' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ParseError);
      expect(result.error.message).toContain('{{UNKNOWN}}');
    }
  });
});
