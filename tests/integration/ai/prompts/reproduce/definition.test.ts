import { describe, expect, it } from 'vitest';
import type { TodoTask, VerificationCriterion } from '@src/domain/entity/task.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { buildReproducePrompt, reproducePromptDef } from '@src/integration/ai/prompts/reproduce/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const DEFAULT_CRITERIA: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'the export endpoint returns 400 for an invalid date', check: 'manual' },
];

const makeTaskWith = (overrides: Parameters<typeof makeTodoTask>[0]): TodoTask =>
  makeTodoTask({ name: 'fix-export-date-validation', verificationCriteria: DEFAULT_CRITERIA, ...overrides });

const SAMPLE_CONTRACT_SECTION = '## Output contract\n\nWrite signals.json. (test fixture body.)';

describe('reproducePromptDef — completeness', () => {
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

  it('asks for an assertion on the stated behaviour and a self-bounded hang', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/differs\s+from\s+today's\s+wrong\s+value/i);
    expect(body).toMatch(/bound\s+it\s+with\s+a\s+timeout\s+inside\s+the\s+test/i);
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

  it('renders the shared evidence-bound partial rather than a hand-duplicated copy', async () => {
    // Regression: this template used to hand-write its own near-verbatim restatement of
    // `_partials/evidence-bound.md` instead of wiring the partial the other four AI-spawning
    // templates already share — a future edit to the shared bound would drift silently here.
    // The partial wraps its body in `<evidence-bound>` tags, so their presence proves the real
    // partial rendered rather than inline prose that merely resembles it.
    expect(reproducePromptDef.partials).toMatchObject({ EVIDENCE_BOUND: 'evidence-bound' });
    const body = await renderedBody();
    expect(body).toContain('<evidence-bound>');
    expect(body).toContain('</evidence-bound>');
  });

  it('wires the autonomous-operation partial (the session runs headless)', async () => {
    expect(reproducePromptDef.partials).toMatchObject({ AUTONOMOUS_OPERATION: 'autonomous-operation' });
    expect(await renderedBody()).toContain('<autonomous-operation>');
  });

  it('bounds the revision loop to two and offers a not-reproduced exit', async () => {
    const body = await renderedBody();
    expect(body).toMatch(/stop after two revisions/i);
    expect(body).toContain('"reproduced": false');
    expect(body).not.toMatch(/until the failure you observe is the actual/);
    expect(body).toMatch(/two-revision bound/);
  });

  it('states the ambiguity rule in the goal, before the output contract', async () => {
    const body = await renderedBody();
    const goal = /<goal>([\s\S]*?)<\/goal>/.exec(body)?.[1] ?? '';
    expect(goal).toMatch(/vague or\s+under-specified/);
  });
});
