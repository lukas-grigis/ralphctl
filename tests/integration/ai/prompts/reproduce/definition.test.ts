import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Result } from '@src/domain/result.ts';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { FIXED_REPOSITORY_ID, makeApprovedTicket } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import { buildReproducePrompt, reproducePromptDef } from '@src/integration/ai/prompts/reproduce/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error('unexpected error in test fixture');
  return r.value as T;
};

const DEFAULT_CRITERIA: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'the export endpoint returns 400 for an invalid date', check: 'manual' },
];

const makeTaskWith = (overrides: {
  name?: string;
  description?: string;
  verificationCriteria?: readonly VerificationCriterion[];
}): TodoTask => {
  const ticket = makeApprovedTicket();
  return unwrap(
    createTask({
      name: overrides.name ?? 'fix-export-date-validation',
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      steps: ['step 1'],
      verificationCriteria:
        overrides.verificationCriteria !== undefined ? [...overrides.verificationCriteria] : DEFAULT_CRITERIA,
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
};

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('reproducePromptDef — completeness', () => {
  it('every placeholder in reproduce/template.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/reproduce/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(reproducePromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(reproducePromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in reproduce/template.md', async () => {
    const path = `${String(defaultTemplatesDir())}/reproduce/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(reproducePromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(reproducePromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('expectedSignals advertises reproduction and note only', () => {
    expect(reproducePromptDef.expectedSignals).toEqual(['reproduction', 'note']);
  });
});

describe('buildReproducePrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt threading the task and contract section through', async () => {
    const task = makeTaskWith({ description: 'Exporting with an invalid date crashes instead of returning 400.' });
    const result = await buildReproducePrompt(deps, {
      task,
      projectPath: '/repo/api',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value as unknown as string;
    expect(body).toContain('<role>');
    expect(body).toContain('<goal>');
    expect(body).toContain('<output_contract>');
    expect(body).toContain('/repo/api');
    expect(body).toContain(task.name);
    expect(body).toContain('Exporting with an invalid date crashes instead of returning 400.');
    expect(body).toContain('## Output contract');
    // No placeholders remain.
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('renders with no prior progress and no project tooling (both optional inputs)', async () => {
    const task = makeTaskWith({});
    const result = await buildReproducePrompt(deps, {
      task,
      projectPath: '/repo/api',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value as unknown as string).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('rejects an empty projectPath via the spec validator', async () => {
    const task = makeTaskWith({});
    const result = await buildReproducePrompt(deps, {
      task,
      projectPath: '   ',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});

describe('reproduce template — reproduction-only guidance', () => {
  const renderedBody = async (): Promise<string> => {
    const task = makeTaskWith({ description: 'Reported defect goes here.' });
    const r = await buildReproducePrompt(deps, {
      task,
      projectPath: '/repo/x',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!r.ok) throw r.error;
    return r.value as unknown as string;
  };

  it('instructs the session not to fix the defect', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/do\s+NOT fix the defect/i);
    expect(body).toMatch(/Reproduction only/i);
  });

  it('requires the test to fail for the reported reason, not a setup/import error', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/not a setup error, an import error/i);
  });

  it('requires exactly one new test, preferring an existing relevant file', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/exactly one new test/i);
  });

  it('mandates recording relevant existing tests even when none are found', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/relevantTests.*even when the search comes\s*\n?\s*up empty/i);
  });

  it('forbids committing the reproduction test', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/do not commit/i);
  });
});
