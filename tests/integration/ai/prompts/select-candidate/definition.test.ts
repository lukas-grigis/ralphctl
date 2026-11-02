import { describe, expect, it } from 'vitest';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import {
  buildSelectCandidatePrompt,
  selectCandidatePromptDef,
} from '@src/integration/ai/prompts/select-candidate/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const DEFAULT_CRITERIA: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'the export endpoint returns 400 for an invalid date', check: 'manual' },
];

const makeTaskWith = (overrides: Parameters<typeof makeTodoTask>[0]): TodoTask =>
  makeTodoTask({ name: 'fix-export-date-validation', verificationCriteria: DEFAULT_CRITERIA, ...overrides });

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';
const CANDIDATE_A =
  'Attempted: added Zod validation. Verification: ran the test suite, 12/12 green. Files: src/routes/exports.ts.';
const CANDIDATE_B =
  'Attempted: added a manual regex check. Verification: not run. Files: src/routes/exports.ts, src/middleware/auth.ts.';

describe('selectCandidatePromptDef — completeness', () => {
  it('expectedSignals advertises candidate-selection only', () => {
    expect(selectCandidatePromptDef.expectedSignals).toEqual(['candidate-selection']);
  });
});

describe('buildSelectCandidatePrompt — end-to-end against the real template', () => {
  it('produces a fully-substituted prompt threading the task and both candidate summaries through', async () => {
    const task = makeTaskWith({ description: 'Invalid export dates must return 400, not crash.' });
    const result = await buildSelectCandidatePrompt(deps, {
      task,
      candidate1Summary: CANDIDATE_A,
      candidate2Summary: CANDIDATE_B,
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

  it('rejects an empty candidate1Summary via the spec validator', async () => {
    const task = makeTaskWith({});
    const result = await buildSelectCandidatePrompt(deps, {
      task,
      candidate1Summary: '   ',
      candidate2Summary: CANDIDATE_B,
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('rejects an empty candidate2Summary via the spec validator', async () => {
    const task = makeTaskWith({});
    const result = await buildSelectCandidatePrompt(deps, {
      task,
      candidate1Summary: CANDIDATE_A,
      candidate2Summary: '',
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
      candidate1Summary: CANDIDATE_A,
      candidate2Summary: CANDIDATE_B,
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

  it('allows a tie (0) and says the presentation order carries no meaning', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/declares a tie \(`0`\)/i);
    expect(body).not.toMatch(/never a tie/i);
    expect(body).toMatch(/order the\s+candidates are shown in carries no meaning/i);
  });

  it('penalises scope creep in the changed-files list', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/scope creep/i);
  });
});
