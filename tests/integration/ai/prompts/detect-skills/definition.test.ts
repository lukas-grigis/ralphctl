import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { computePlaceholderParity, loadPartialMap } from '@src/integration/ai/prompts/_engine/test-utils.ts';
import {
  buildDetectSkillsPrompt,
  detectSkillsPromptDef,
} from '@src/integration/ai/prompts/detect-skills/definition.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

const readTemplate = async (): Promise<string> =>
  fs.readFile(`${String(defaultTemplatesDir())}/detect-skills/template.md`, 'utf8');

describe('detectSkillsPromptDef — completeness', () => {
  it('placeholder ↔ parameter parity', async () => {
    const rawTemplate = await readTemplate();
    const partials = await loadPartialMap(detectSkillsPromptDef, loader);
    const report = computePlaceholderParity({ def: detectSkillsPromptDef, rawTemplate, partials });
    expect(report.unsatisfied).toEqual([]);
    expect(report.unreferenced).toEqual([]);
  });
});

describe('buildDetectSkillsPrompt — end-to-end', () => {
  it('renders a fully-substituted prompt', async () => {
    const result = await buildDetectSkillsPrompt(loader, {
      repositoryPath: '/tmp/repo',
      skillsConvention: 'Skills land in `.claude/skills/<name>/SKILL.md`.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(result.value).toContain('/tmp/repo');
  });

  it('rejects empty repositoryPath', async () => {
    const result = await buildDetectSkillsPrompt(loader, { repositoryPath: '  ', skillsConvention: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects empty skillsConvention', async () => {
    const result = await buildDetectSkillsPrompt(loader, { repositoryPath: '/x', skillsConvention: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
