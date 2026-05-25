import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { computePlaceholderParity, loadPartialMap } from '@src/integration/ai/prompts/_engine/test-utils.ts';
import { buildIdeatePrompt, ideatePromptDef } from '@src/integration/ai/prompts/ideate/definition.ts';
import { makeProject } from '@tests/fixtures/domain.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

const readTemplate = async (): Promise<string> =>
  fs.readFile(`${String(defaultTemplatesDir())}/ideate/template.md`, 'utf8');

describe('ideatePromptDef — completeness', () => {
  it('placeholder ↔ parameter parity', async () => {
    const rawTemplate = await readTemplate();
    const partials = await loadPartialMap(ideatePromptDef, loader);
    const report = computePlaceholderParity({ def: ideatePromptDef, rawTemplate, partials });
    expect(report.unsatisfied).toEqual([]);
    expect(report.unreferenced).toEqual([]);
  });
});

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('buildIdeatePrompt — end-to-end', () => {
  it('renders a fully-substituted prompt', async () => {
    const project = makeProject({ displayName: 'Demo' });
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: 'CSV export',
      ideaDescription: 'Add CSV export to reports.',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(result.value).toContain('CSV export');
    expect(result.value).toContain('## Output contract');
    expect(result.value).toContain('<prior_progress>');
  });

  it('rejects empty ideaTitle', async () => {
    const project = makeProject();
    const result = await buildIdeatePrompt(loader, {
      ideaTitle: '   ',
      ideaDescription: 'desc',
      project,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
