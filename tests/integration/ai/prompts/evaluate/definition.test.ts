import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Result } from '@src/domain/result.ts';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { FIXED_REPOSITORY_ID, makeApprovedTicket, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import { buildEvaluatePrompt, evaluatePromptDef } from '@src/integration/ai/prompts/evaluate/definition.ts';

// The shared task renderers (renderTaskDescriptionSection / renderTaskStepsSection /
// renderVerificationCriteriaSection / renderCheckScriptSection / renderProjectToolingSection)
// live in `renderers/task.ts` and are unit-tested in `definitions/implement.test.ts`. The
// evaluate definition consumes them verbatim, so this suite focuses on the placeholder
// manifest, the end-to-end build, and validate-rejected paths instead of re-asserting the
// renderer outputs.

const deps = createFsTemplateLoader(defaultTemplatesDir());

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error('unexpected error in test fixture');
  return r.value as T;
};

const DEFAULT_CRITERIA: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'runs to completion', check: 'manual' },
];

const makeTaskWith = (overrides: {
  name?: string;
  description?: string;
  steps?: readonly string[];
  verificationCriteria?: readonly VerificationCriterion[];
}): TodoTask => {
  const ticket = makeApprovedTicket();
  return unwrap(
    createTask({
      name: overrides.name ?? 'do-the-work',
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      steps: overrides.steps !== undefined ? [...overrides.steps] : ['step 1'],
      verificationCriteria:
        overrides.verificationCriteria !== undefined ? [...overrides.verificationCriteria] : DEFAULT_CRITERIA,
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
};

const CONTRACT_PATH = '/tmp/ralph/main-repo/contract.md';

describe('evaluatePromptDef — completeness', () => {
  it('every placeholder in evaluate.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/evaluate/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(evaluatePromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(evaluatePromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in evaluate.md', async () => {
    const path = `${String(defaultTemplatesDir())}/evaluate/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(evaluatePromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(evaluatePromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('declares the single `evaluation` signal type for both passed and failed verdicts', () => {
    expect(evaluatePromptDef.expectedSignals).toEqual(['evaluation']);
  });

  it('wires only the harness-context partial — output contract is a parameter, not a partial', () => {
    expect(evaluatePromptDef.partials).toEqual({
      HARNESS_CONTEXT: 'harness-context',
    });
  });

  it('declares the OUTPUT_CONTRACT_SECTION placeholder for the audit-[09] contract block', () => {
    const placeholders = Object.values(evaluatePromptDef.parameters).map((p) => p.placeholder);
    expect(placeholders).toContain('OUTPUT_CONTRACT_SECTION');
  });

  it('declares the PRIOR_PROGRESS placeholder so the reviewer sees the sprint journal body', () => {
    const placeholders = Object.values(evaluatePromptDef.parameters).map((p) => p.placeholder);
    expect(placeholders).toContain('PRIOR_PROGRESS');
  });
});

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('buildEvaluatePrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt with title, task name, project path, and no leftover placeholders', async () => {
    const task = makeTaskWith({ name: 'export CSV', description: 'Add CSV export to the report endpoint.' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      verifyScript: 'npm run check',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('**Task:** export CSV');
    expect(result.value).toContain('/tmp/ralph/main-repo');
    expect(result.value).toContain('## Description');
    expect(result.value).toContain('Add CSV export to the report endpoint.');
    expect(result.value).toContain('npm run check');
    // Default tooling fallback is rendered when projectTooling is omitted.
    expect(result.value).toContain('_(none detected)_');
    // No leftover placeholders.
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('omits the description block entirely when the task has no description', async () => {
    const task = makeTaskWith({ name: 'short task' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('## Description');
    // Sanity: the rest of the prompt still rendered.
    expect(result.value).toContain('**Task:** short task');
    expect(result.value).toContain('No verify script configured for this repo.');
  });

  it('uses the task name from a default fixture without crashing when no overrides are supplied', async () => {
    const task = makeTodoTask();
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain(task.name);
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('omits the extra-dimensions block when task.extraDimensions is unset', async () => {
    const task = makeTaskWith({});
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('Task-specific dimensions');
    expect(result.value).toContain('**Consistency**');
  });

  it('renders generator hints inside a framing block when provided', async () => {
    const task = makeTaskWith({ name: 'with-hints' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
      generatorHints: 'Dev server runs on port 3001. Known quirk: first run logs a deprecation warning.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<generator_hints>');
    expect(result.value).toContain('port 3001');
    // The framing must warn the evaluator these are unverified claims.
    expect(result.value).toContain('unverified claims');
    expect(result.value).toContain('NEVER as evidence');
  });

  it('omits the generator-hints block entirely when generatorHints is absent', async () => {
    const task = makeTaskWith({ name: 'no-hints' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('<generator_hints>');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('inlines the priorProgress body into the `## Prior progress` section', async () => {
    const task = makeTaskWith({ name: 'with-prior' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
      priorProgress: '## Task: shipped-earlier — Attempt 1\n\nTask completed successfully.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<prior_progress>');
    expect(result.value).toContain('## Task: shipped-earlier — Attempt 1');
  });

  it('renders extra dimensions after the floor dimensions when planner attached them', async () => {
    const ticket = makeApprovedTicket();
    const task = unwrap(
      createTask({
        name: 'add a11y',
        steps: ['add aria labels'],
        verificationCriteria: [{ id: 'C1', assertion: 'screen reader announces button', check: 'manual' }],
        order: 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
        extraDimensions: ['accessibility', 'performance'],
      })
    );
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      contractPath: CONTRACT_PATH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('Task-specific dimensions');
    expect(result.value).toContain('5. **accessibility**');
    expect(result.value).toContain('6. **performance**');
    // Extras must come after the four floor dimensions.
    const floorIdx = result.value.indexOf('**Consistency**');
    const extrasIdx = result.value.indexOf('Task-specific dimensions');
    expect(floorIdx).toBeGreaterThan(-1);
    expect(extrasIdx).toBeGreaterThan(floorIdx);
  });
});

describe('evaluatePromptDef — validate-rejected paths', () => {
  it('rejects an empty taskName', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, evaluatePromptDef, {
      taskName: '   ',
      projectPath: '/tmp/ralph/main-repo',
      contractPath: CONTRACT_PATH,
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      extraDimensionsSection: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
      generatorHintsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty projectPath', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, evaluatePromptDef, {
      taskName: 'export CSV',
      projectPath: '',
      contractPath: CONTRACT_PATH,
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      extraDimensionsSection: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
      generatorHintsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty contractPath', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, evaluatePromptDef, {
      taskName: 'export CSV',
      projectPath: '/tmp/ralph/main-repo',
      contractPath: '',
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      extraDimensionsSection: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorProgress: '',
      generatorHintsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
