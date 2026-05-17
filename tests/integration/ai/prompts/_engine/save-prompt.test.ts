import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { savePrompt } from '@src/integration/ai/prompts/_engine/save-prompt.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';

describe('savePrompt', () => {
  let tmpRoot: string;
  const writeFile = createAtomicWriteFile();

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-prompt-'));
    tmpRoot = await realpath(raw);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes the prompt content to disk verbatim', async () => {
    const path = AbsolutePath.parse(join(tmpRoot, 'out.md'));
    if (!path.ok) throw path.error;
    const prompt = '# Hello\n\nThis is a rendered prompt.\n' as Prompt;

    const result = await savePrompt(writeFile, path.value, prompt);
    expect(result.ok).toBe(true);

    const written = await fs.readFile(path.value, 'utf8');
    expect(written).toBe(prompt);
  });

  it('creates parent directories on the way to the target', async () => {
    const path = AbsolutePath.parse(join(tmpRoot, 'nested', 'deeper', 'prompt.md'));
    if (!path.ok) throw path.error;
    const result = await savePrompt(writeFile, path.value, 'body' as Prompt);
    expect(result.ok).toBe(true);

    const written = await fs.readFile(path.value, 'utf8');
    expect(written).toBe('body');
  });

  it('overwrites an existing file (atomic — readers see old or full new)', async () => {
    const path = AbsolutePath.parse(join(tmpRoot, 'overwrite.md'));
    if (!path.ok) throw path.error;
    await savePrompt(writeFile, path.value, 'first' as Prompt);
    await savePrompt(writeFile, path.value, 'second' as Prompt);
    expect(await fs.readFile(path.value, 'utf8')).toBe('second');
  });
});
