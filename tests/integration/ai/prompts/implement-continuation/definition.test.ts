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
  buildImplementContinuationPrompt,
  implementContinuationPromptDef,
} from '@src/integration/ai/prompts/implement-continuation/definition.ts';

const deps = createFsTemplateLoader(defaultTemplatesDir());

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error('unexpected error in test fixture');
  return r.value as T;
};

const DEFAULT_CRITERIA: readonly VerificationCriterion[] = [
  { id: 'C1', assertion: 'runs to completion', check: 'manual' },
];

const makeTaskWith = (overrides: { verificationCriteria?: readonly VerificationCriterion[] }): TodoTask => {
  const ticket = makeApprovedTicket();
  return unwrap(
    createTask({
      name: 'do-the-work',
      steps: ['step 1'],
      verificationCriteria:
        overrides.verificationCriteria !== undefined ? [...overrides.verificationCriteria] : DEFAULT_CRITERIA,
      order: 1,
      ticketId: ticket.id,
      repositoryId: FIXED_REPOSITORY_ID,
    })
  );
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

  it('asks for a contrasting learning and a commit-message rollback note, mirroring the full implement prompt', async () => {
    const template = (await fs.readFile(TEMPLATE_PATH, 'utf8')).replace(/\s+/g, ' ');
    expect(template).toContain('contrast a now-working approach with what failed');
    expect(template).toContain('remaining uncertainty and, when the change is risky, how to roll it back');
  });

  it('carries a <success_criteria> block naming the no-test-weakening rule unconditionally', async () => {
    const template = (await fs.readFile(TEMPLATE_PATH, 'utf8')).replace(/\s+/g, ' ');
    expect(template).toContain('<success_criteria>');
    expect(template).toContain('No test has been removed, disabled, or weakened to reach a pass');
  });

  it('wires the autonomous-operation and evidence-bound partials', () => {
    expect(implementContinuationPromptDef.partials).toMatchObject({
      AUTONOMOUS_OPERATION: 'autonomous-operation',
      EVIDENCE_BOUND: 'evidence-bound',
    });
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
    expect(result.value.replace(/\s+/g, ' ')).toContain('re-read these on-disk files');
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

  it('renders prior attempts when priorAttempts is provided', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      priorAttempts: 'Attempt 2 passed C1/C2; attempt 1 regressed C2 by skipping input validation.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<prior_attempts>');
    expect(result.value).toContain('regressed C2 by skipping input validation');
  });

  it('omits prior attempts content when priorAttempts is absent (placeholder collapses cleanly)', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('<prior_attempts>');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
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

  it('renders pre-verify results when preVerifyOutput is provided', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      preVerifyOutput: '3 suites green, 0 failures.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<pre_verify_results>');
    expect(result.value).toContain('3 suites green');
  });

  it('renders retry feedback when retryFeedback is provided', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      retryFeedback: 'Command: pnpm typecheck\nExit 1: TS2345 at src/foo.ts:12',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<retry_feedback>');
    expect(result.value).toContain('TS2345 at src/foo.ts:12');
  });

  it('collapses pre-verify and retry-feedback blocks cleanly when absent', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 2,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('<pre_verify_results>');
    expect(result.value).toContain('<retry_feedback>');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('unconditionally re-injects the done-criteria when the task is threaded through', async () => {
    const task = makeTaskWith({
      verificationCriteria: [{ id: 'C1', assertion: 'export endpoint returns CSV', check: 'manual' }],
    });
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
      task,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('## Done criteria');
    expect(result.value).toContain('export endpoint returns CSV');
  });

  it('falls back to the explicit empty-case sentence when the task is not threaded through', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain('## Done criteria');
    expect(result.value).toContain('no criteria were threaded into this round');
    expect(result.value).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('tells the model the user is not watching', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('operating autonomously');
    expect(result.value).toContain('not watching in real time');
  });

  it('gives the empty plateau_directive block an explicit empty-case sentence', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('no plateau escalation applies this round');
  });

  it('states the bounded-evidence rule exactly once via the shared partial', async () => {
    const result = await buildImplementContinuationPrompt(deps, {
      roundNumber: 3,
      contractPath: CONTRACT_PATH,
      progressFile: PROGRESS_FILE,
      priorProgress: '',
      outputContractSection: SAMPLE_CONTRACT_SECTION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flattened = result.value.replace(/\s+/g, ' ');
    const occurrences = flattened.split('rather than the full log').length - 1;
    expect(occurrences).toBe(1);
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
      preVerifyResults: '',
      retryFeedbackSection: '',
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
      preVerifyResults: '',
      retryFeedbackSection: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });
});
