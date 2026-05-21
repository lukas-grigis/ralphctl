import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Result } from '@src/domain/result.ts';
import { createTask, type TodoTask } from '@src/domain/entity/task.ts';
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

const makeTaskWith = (overrides: {
  name?: string;
  description?: string;
  steps?: readonly string[];
  verificationCriteria?: readonly string[];
}): TodoTask => {
  const ticket = makeApprovedTicket();
  return unwrap(
    createTask({
      name: overrides.name ?? 'do-the-work',
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      steps: overrides.steps !== undefined ? [...overrides.steps] : ['step 1'],
      verificationCriteria:
        overrides.verificationCriteria !== undefined ? [...overrides.verificationCriteria] : ['runs to completion'],
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
};

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

  it('uses `signals-evaluation` (not `signals-task`) for the SIGNALS partial', () => {
    expect(evaluatePromptDef.partials).toEqual({
      HARNESS_CONTEXT: 'harness-context',
      SIGNALS: 'signals-evaluation',
    });
  });
});

describe('buildEvaluatePrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt with title, task name, project path, and no leftover placeholders', async () => {
    const task = makeTaskWith({ name: 'export CSV', description: 'Add CSV export to the report endpoint.' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
      verifyScript: 'npm run check',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain('# Code Review: export CSV');
    expect(result.value).toContain('**Task:** export CSV');
    expect(result.value).toContain('/tmp/ralph/main-repo');
    expect(result.value).toContain('## Description');
    expect(result.value).toContain('Add CSV export to the report endpoint.');
    expect(result.value).toContain('npm run check');
    // Default tooling fallback is rendered when projectTooling is omitted.
    expect(result.value).toContain('_(none detected)_');
    // The evaluation-specific signals partial is wired in.
    expect(result.value).toContain('<evaluation-passed>');
    expect(result.value).toContain('<evaluation-failed>');
    // No leftover placeholders.
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('omits the description block entirely when the task has no description', async () => {
    const task = makeTaskWith({ name: 'short task' });
    const result = await buildEvaluatePrompt(deps, {
      task,
      projectPath: '/tmp/ralph/main-repo',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('## Description');
    // Sanity: the rest of the prompt still rendered.
    expect(result.value).toContain('# Code Review: short task');
    expect(result.value).toContain('No verify script configured for this repo.');
  });

  it('uses the task name from a default fixture without crashing when no overrides are supplied', async () => {
    const task = makeTodoTask();
    const result = await buildEvaluatePrompt(deps, { task, projectPath: '/tmp/ralph/main-repo' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain(task.name);
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('omits the extra-dimensions block when task.extraDimensions is unset', async () => {
    const task = makeTaskWith({});
    const result = await buildEvaluatePrompt(deps, { task, projectPath: '/tmp/ralph/main-repo' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('Task-specific dimensions');
    expect(result.value).toContain('**Consistency**');
  });

  it('renders extra dimensions after the floor dimensions when planner attached them', async () => {
    const ticket = makeApprovedTicket();
    const task = unwrap(
      createTask({
        name: 'add a11y',
        steps: ['add aria labels'],
        verificationCriteria: ['screen reader announces button'],
        order: 1,
        ticketId: ticket.id,
        repositoryId: FIXED_REPOSITORY_ID,
        extraDimensions: ['accessibility', 'performance'],
      })
    );
    const result = await buildEvaluatePrompt(deps, { task, projectPath: '/tmp/ralph/main-repo' });
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
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      extraDimensionsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty projectPath', async () => {
    const { buildPrompt } = await import('@src/integration/ai/prompts/_engine/build-prompt.ts');
    const result = await buildPrompt(deps, evaluatePromptDef, {
      taskName: 'export CSV',
      projectPath: '',
      taskDescriptionSection: '',
      taskStepsSection: '',
      verificationCriteriaSection: '',
      verifyScriptSection: 'No verify script configured for this repo.',
      projectTooling: '_(none detected)_',
      extraDimensionsSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
