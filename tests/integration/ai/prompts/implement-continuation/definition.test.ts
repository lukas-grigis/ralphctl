import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Result } from '@src/domain/result.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildImplementContinuationPrompt,
  implementContinuationPromptDef,
} from '@src/integration/ai/prompts/implement-continuation/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error('unexpected error in test fixture');
  return r.value as T;
};

const TEMPLATE_PATH = `${String(defaultTemplatesDir())}/implement-continuation/template.md`;
const CONTRACT_PATH = '/tmp/ralph/main-repo/contract.md';
const PROGRESS_FILE = '/tmp/ralph/sprint-1/progress.md';
const SAMPLE_CONTRACT_SECTION =
  '## Output contract\n\nWrite /tmp/ralph/sandbox/rounds/3/generator/signals.json. (test fixture body.)';

describe('implementContinuationPromptDef — completeness', () => {
  it('every placeholder in the template is declared by the definition (parameters or partials)', async () => {
    const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(implementContinuationPromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(implementContinuationPromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in the template', async () => {
    const template = await fs.readFile(TEMPLATE_PATH, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(implementContinuationPromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(implementContinuationPromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('declares the same accepted signal union as the full implement prompt', () => {
    expect(implementContinuationPromptDef.expectedSignals).toEqual([
      'change',
      'decision',
      'learning',
      'note',
      'task-verified',
      'task-complete',
      'task-blocked',
      'commit-message',
    ]);
  });
});

describe('buildImplementContinuationPrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt naming the round, contract path, and progress file', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 4,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '## Task: earlier — Attempt 1\n\nsome history',
      priorCritique: '## Completeness\n- step 3 verification missing',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('# Continue — Round 4');
    expect(result.value).toContain(CONTRACT_PATH);
    expect(result.value).toContain(PROGRESS_FILE);
    // The prior critique rides verbatim so the resumed generator addresses the flagged dimensions.
    expect(result.value).toContain('step 3 verification missing');
    // The cold-resume hedge tells a context-free thread where to re-read the brief.
    expect(result.value).toContain('re-read these on-disk files');
    // No leftover placeholders.
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('names the CURRENT round output path via the output-contract section the leaf renders per round', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The leaf passes a section rendered against rounds/<N>/generator/; the round-3 path must appear.
    expect(result.value).toContain('rounds/3/generator/signals.json');
  });

  it('renders the plateau directive when plateauBreak is set, and omits it otherwise', async () => {
    const withDirective = unwrap(
      await buildImplementContinuationPrompt(deps, {
        roundNumber: 5,
        contractPath: CONTRACT_PATH,
        progressFile: PROGRESS_FILE,
        priorProgress: '',
        outputContractSection: SAMPLE_CONTRACT_SECTION,
        plateauBreak: true,
      })
    );
    expect(withDirective).toContain('You have plateaued');
    expect(withDirective).toContain('change your approach');

    const without = unwrap(
      await buildImplementContinuationPrompt(deps, {
        roundNumber: 5,
        contractPath: CONTRACT_PATH,
        progressFile: PROGRESS_FILE,
        priorProgress: '',
        outputContractSection: SAMPLE_CONTRACT_SECTION,
      })
    );
    expect(without).not.toContain('You have plateaued');
  });

  it('substitutes an empty prior-progress cleanly (no orphan placeholder, surrounding prose intact)', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
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
});

describe('implementContinuationPromptDef — validate-rejected paths', () => {
  it('rejects an empty roundNumber', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, implementContinuationPromptDef, {
      roundNumber: '   ',
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      priorCritiqueSection: '',
      plateauDirectiveSection: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty outputContractSection', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, implementContinuationPromptDef, {
      roundNumber: '4',
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      priorCritiqueSection: '',
      plateauDirectiveSection: '',
      outputContractSection: '   ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
