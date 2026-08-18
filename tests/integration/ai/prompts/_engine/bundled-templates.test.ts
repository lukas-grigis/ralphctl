import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_PROMPT_PARTIALS,
  BUNDLED_PROMPT_TEMPLATES,
} from '@src/integration/ai/prompts/_engine/bundled-templates.ts';
import { createFsTemplateLoader } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'src',
  'integration',
  'ai',
  'prompts'
);

/**
 * Parity fence for the inventory `ralphctl prompts list` walks. The command is the only
 * non-interactive surface that exercises the prompt-template resolver, and the CI + release dist
 * smokes grep it — a prompt that is not in the inventory is a prompt outside that gate, so a new
 * prompt directory must fail here rather than silently opt out.
 */
describe('bundled prompt inventory', () => {
  it('matches the prompt directories on disk', async () => {
    const entries = await fs.readdir(PROMPTS_DIR, { withFileTypes: true });
    const onDisk = entries
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort();

    expect([...BUNDLED_PROMPT_TEMPLATES].sort()).toEqual(onDisk);
  });

  it('matches the partials on disk', async () => {
    const entries = await fs.readdir(join(PROMPTS_DIR, '_partials'), { withFileTypes: true });
    const onDisk = entries
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name.replace(/\.md$/, ''))
      .sort();

    expect([...BUNDLED_PROMPT_PARTIALS].sort()).toEqual(onDisk);
  });

  it('every listed name loads a non-empty body through the real loader', async () => {
    const dir = AbsolutePath.parse(PROMPTS_DIR);
    expect(dir.ok).toBe(true);
    if (!dir.ok) return;
    const loader = createFsTemplateLoader(dir.value);

    for (const name of [...BUNDLED_PROMPT_TEMPLATES, ...BUNDLED_PROMPT_PARTIALS]) {
      const body = await loader.load(name);
      expect(body.ok, `failed to load '${name}'`).toBe(true);
      if (body.ok) expect(body.value.trim().length, `'${name}' is empty`).toBeGreaterThan(0);
    }
  });
});
