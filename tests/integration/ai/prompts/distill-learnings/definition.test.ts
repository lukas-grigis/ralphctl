import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { computePlaceholderParity, loadPartialMap } from '@src/integration/ai/prompts/_engine/test-utils.ts';
import {
  buildDistillLearningsPrompt,
  distillLearningsPromptDef,
} from '@src/integration/ai/prompts/distill-learnings/definition.ts';

const loader = createFsTemplateLoader(defaultTemplatesDir());

const readTemplate = async (): Promise<string> =>
  fs.readFile(`${String(defaultTemplatesDir())}/distill-learnings/template.md`, 'utf8');

const VALID_INPUT = {
  existingContextFile: '# CLAUDE.md\n\nProject guidance.',
  candidateLearnings: '- The build emits ESM only.\n- Prefer the injected port over direct fs.',
  targetFilename: 'CLAUDE.md',
  projectTooling: 'Detected: pnpm + vitest.',
} as const;

describe('distillLearningsPromptDef — completeness', () => {
  it('placeholder ↔ parameter parity (both directions)', async () => {
    const rawTemplate = await readTemplate();
    const partials = await loadPartialMap(distillLearningsPromptDef, loader);
    const report = computePlaceholderParity({ def: distillLearningsPromptDef, rawTemplate, partials });
    // No placeholder in the template lacks a parameter spec…
    expect(report.unsatisfied).toEqual([]);
    // …and no declared parameter / partial goes unreferenced.
    expect(report.unreferenced).toEqual([]);
  });

  it('declares exactly the four spec placeholders', async () => {
    const rawTemplate = await readTemplate();
    const partials = await loadPartialMap(distillLearningsPromptDef, loader);
    const report = computePlaceholderParity({ def: distillLearningsPromptDef, rawTemplate, partials });
    expect(report.declaredParameters).toEqual(
      ['CANDIDATE_LEARNINGS', 'EXISTING_CONTEXT_FILE', 'PROJECT_TOOLING', 'TARGET_FILENAME'].sort()
    );
  });

  it('the template hardcodes no package-manager commands outside PROJECT_TOOLING', async () => {
    const rawTemplate = await readTemplate();
    // The copy rule: package-manager invocations belong only inside the {{PROJECT_TOOLING}} block.
    expect(rawTemplate).not.toMatch(/\b(pnpm|npm|yarn|pip|cargo|go test)\b/);
  });
});

describe('buildDistillLearningsPrompt — end-to-end', () => {
  it('renders a fully-substituted prompt', async () => {
    const result = await buildDistillLearningsPrompt(loader, VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(result.value).toContain('CLAUDE.md');
    expect(result.value).toContain('## Learnings (ralphctl)');
    expect(result.value).toContain('The build emits ESM only.');
    expect(result.value).toContain('Detected: pnpm + vitest.');
  });

  it('rejects empty candidateLearnings', async () => {
    const result = await buildDistillLearningsPrompt(loader, { ...VALID_INPUT, candidateLearnings: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects empty targetFilename', async () => {
    const result = await buildDistillLearningsPrompt(loader, { ...VALID_INPUT, targetFilename: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
