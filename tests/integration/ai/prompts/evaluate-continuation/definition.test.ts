import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildEvaluateContinuationPrompt,
  evaluateContinuationPromptDef,
} from '@src/integration/ai/prompts/evaluate-continuation/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const TEMPLATE_PATH = `${String(defaultTemplatesDir())}/evaluate-continuation/template.md`;
const CONTRACT_PATH = '/tmp/ralph/main-repo/contract.md';
const PROGRESS_FILE = '/tmp/ralph/sprint-1/progress.md';
const SAMPLE_CONTRACT_SECTION =
  '## Output contract\n\nWrite /tmp/ralph/sandbox/rounds/3/evaluator/signals.json. (test fixture body.)';

describe('evaluateContinuationPromptDef — completeness', () => {
  it('every placeholder in the template is declared by the definition (parameters or partials)', async () => {
    const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(evaluateContinuationPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(evaluateContinuationPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in the template', async () => {
    const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(evaluateContinuationPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(evaluateContinuationPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('declares the single evaluation-verdict signal the full evaluate prompt does', () => {
    expect(evaluateContinuationPromptDef.expectedSignals).toEqual(['evaluation']);
  });
});

describe('buildEvaluateContinuationPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt naming the round, contract path, and progress file', async () => {
    const result = await buildEvaluateContinuationPrompt(deps, {
      roundNumber: 4,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '## Task: earlier — Attempt 1\n\nsome history',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('# Re-evaluate — Round 4');
    expect(result.value).toContain(CONTRACT_PATH);
    expect(result.value).toContain(PROGRESS_FILE);
    // The verdict-format reminder must ride so the reviewer stays consistent on the floor
    // dimensions and malformed semantics across rounds (kept in sync with evaluate/template.md).
    expect(result.value).toContain('correctness, completeness, safety, consistency');
    expect(result.value).toContain('malformed');
    // The cold-resume hedge tells a context-free thread where to re-read the specification.
    expect(result.value).toContain('re-read these on-disk files');
    // No leftover placeholders.
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('names the CURRENT round output path via the output-contract section the leaf renders per round', async () => {
    const result = await buildEvaluateContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('rounds/3/evaluator/signals.json');
  });

  it('substitutes an empty prior-progress cleanly (no orphan placeholder, surrounding prose intact)', async () => {
    const result = await buildEvaluateContinuationPrompt(deps, {
      roundNumber: 2,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('renders generator hints when provided', async () => {
    const result = await buildEvaluateContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      generatorHints: 'Dev server on port 4000.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<generator_hints>');
    expect(result.value).toContain('port 4000');
    expect(result.value).toContain('unverified claims');
  });

  it('omits the generator-hints block when generatorHints is absent (collapses cleanly)', async () => {
    const result = await buildEvaluateContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('<generator_hints>');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('evaluateContinuationPromptDef — validate-rejected paths', () => {
  it('rejects an empty roundNumber', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, evaluateContinuationPromptDef, {
      roundNumber: '   ',
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      generatorHintsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty outputContractSection', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, evaluateContinuationPromptDef, {
      roundNumber: '4',
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: '   ',
      generatorHintsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
