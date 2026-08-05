import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Result } from '@src/domain/result.ts';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { createTask } from '@src/domain/entity/task-factory.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { FIXED_REPOSITORY_ID, makeApprovedTicket } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { extractPlaceholders } from '@src/integration/ai/prompts/_engine/extract-placeholders.ts';
import {
  buildSelectCandidatePrompt,
  selectCandidatePromptDef,
} from '@src/integration/ai/prompts/select-candidate/definition.ts';

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
const CANDIDATE_A =
  'Attempted: added Zod validation. Verification: ran the test suite, 12/12 green. Files: src/routes/exports.ts.';
const CANDIDATE_B =
  'Attempted: added a manual regex check. Verification: not run. Files: src/routes/exports.ts, src/middleware/auth.ts.';

describe('selectCandidatePromptDef — completeness', () => {
  it('every placeholder in select-candidate/template.md is declared by the definition (parameters or partials)', async () => {
    const path = `${String(defaultTemplatesDir())}/select-candidate/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = extractPlaceholders(template);

    const declared = new Set([
      ...Object.values(selectCandidatePromptDef.parameters).map((p) => p.placeholder),
      ...Object.keys(selectCandidatePromptDef.partials ?? {}),
    ]);
    for (const placeholder of placeholders) {
      expect(declared.has(placeholder), `template uses {{${placeholder}}} but the def doesn't declare it`).toBe(true);
    }
  });

  it('every placeholder declared by the definition exists in select-candidate/template.md', async () => {
    const path = `${String(defaultTemplatesDir())}/select-candidate/template.md`;
    const template = await fs.readFile(path, 'utf8');
    const placeholders = new Set(extractPlaceholders(template));

    for (const spec of Object.values(selectCandidatePromptDef.parameters)) {
      expect(
        placeholders.has(spec.placeholder),
        `def declares {{${spec.placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
    for (const placeholder of Object.keys(selectCandidatePromptDef.partials ?? {})) {
      expect(
        placeholders.has(placeholder),
        `def declares partial slot {{${placeholder}}} but template doesn't use it`
      ).toBe(true);
    }
  });

  it('expectedSignals advertises candidate-selection only', () => {
    expect(selectCandidatePromptDef.expectedSignals).toEqual(['candidate-selection']);
  });
});

describe('buildSelectCandidatePrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt threading the task and both candidate summaries through', async () => {
    const task = makeTaskWith({ description: 'Invalid export dates must return 400, not crash.' });
    const result = await buildSelectCandidatePrompt(deps, {
      task,
      candidateASummary: CANDIDATE_A,
      candidateBSummary: CANDIDATE_B,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value as unknown as string;
    expect(body).toContain('<role>');
    expect(body).toContain('<goal>');
    expect(body).toContain('<output_contract>');
    expect(body).toContain(task.name);
    expect(body).toContain(CANDIDATE_A);
    expect(body).toContain(CANDIDATE_B);
    expect(body).toContain('## Output contract');
    // No placeholders remain.
    expect(body).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('rejects an empty candidateASummary via the spec validator', async () => {
    const task = makeTaskWith({});
    const result = await buildSelectCandidatePrompt(deps, {
      task,
      candidateASummary: '   ',
      candidateBSummary: CANDIDATE_B,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty candidateBSummary via the spec validator', async () => {
    const task = makeTaskWith({});
    const result = await buildSelectCandidatePrompt(deps, {
      task,
      candidateASummary: CANDIDATE_A,
      candidateBSummary: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});

describe('select-candidate template — pairwise-judge guidance', () => {
  const renderedBody = async (): Promise<string> => {
    const task = makeTaskWith({ description: 'Invalid export dates must return 400, not crash.' });
    const r = await buildSelectCandidatePrompt(deps, {
      task,
      candidateASummary: CANDIDATE_A,
      candidateBSummary: CANDIDATE_B,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    if (!r.ok) throw r.error;
    return r.value as unknown as string;
  };

  it('forbids reading the candidates actual diff/branch — summaries are the entire evidence base', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/do not attempt to read either candidate's\s*\n?\s*actual diff, branch/i);
  });

  it('instructs the judge to weigh cited verification over unverified confidence', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/evidence over confidence|unverified narrative claim/i);
  });

  it('forbids a tie — the verdict must name exactly one winner', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/never a tie, never both, never neither/i);
  });

  it('penalises scope creep in the changed-files list', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/scope creep/i);
  });
});
