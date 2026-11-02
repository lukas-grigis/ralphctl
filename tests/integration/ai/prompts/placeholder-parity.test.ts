import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { ALL_PROMPT_DEFS } from '@tests/fixtures/prompt-defs.ts';
import { computePlaceholderParity, loadPartialMap } from '@tests/fixtures/prompt-parity.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

describe('prompt definition ↔ template placeholder parity', () => {
  it.each(ALL_PROMPT_DEFS.map((def) => [def.templateName, def] as const))('%s', async (_name, def) => {
    const rawTemplate = await fs.readFile(`${String(defaultTemplatesDir())}/${def.templateName}/template.md`, 'utf8');
    const partials = await loadPartialMap(def, loader);
    const report = computePlaceholderParity({ def, rawTemplate, partials });
    expect(report.unsatisfied, 'template uses placeholders the definition does not declare').toEqual([]);
    expect(report.unreferenced, 'definition declares placeholders the template never uses').toEqual([]);
  });

  it('flags a placeholder missing from the definition and a declared one missing from the template', () => {
    const def = {
      templateName: 'fake',
      description: '',
      parameters: {
        used: { placeholder: 'USED', description: '' },
        orphan: { placeholder: 'ORPHAN', description: '' },
      },
      expectedSignals: [],
    } as never;
    const report = computePlaceholderParity({ def, rawTemplate: '{{USED}} {{UNDECLARED}}', partials: {} });
    expect(report.unsatisfied).toEqual(['UNDECLARED']);
    expect(report.unreferenced).toEqual(['ORPHAN']);
  });
});
