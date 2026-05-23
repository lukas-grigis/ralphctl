import { describe, expect, it } from 'vitest';
import { changeSignalSchema } from '@src/integration/ai/contract/_engine/signals/change/schema.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import { learningSignalSchema } from '@src/integration/ai/contract/_engine/signals/learning/schema.ts';
import { noteSignalSchema } from '@src/integration/ai/contract/_engine/signals/note/schema.ts';
import { progressSignalSchema } from '@src/integration/ai/contract/_engine/signals/progress/schema.ts';
import { progressEntrySignalSchema } from '@src/integration/ai/contract/_engine/signals/progress-entry/schema.ts';
import { evaluationSignalSchema } from '@src/integration/ai/contract/_engine/signals/evaluation/schema.ts';
import { commitMessageSignalSchema } from '@src/integration/ai/contract/_engine/signals/commit-message/schema.ts';
import { taskVerifiedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-verified/schema.ts';
import { taskCompleteSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-complete/schema.ts';
import { taskBlockedSignalSchema } from '@src/integration/ai/contract/_engine/signals/task-blocked/schema.ts';
import { agentsMdProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/agents-md-proposal/schema.ts';
import { setupScriptSignalSchema } from '@src/integration/ai/contract/_engine/signals/setup-script/schema.ts';
import { verifyScriptSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-script/schema.ts';
import { setupSkillProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/setup-skill-proposal/schema.ts';
import { verifySkillProposalSignalSchema } from '@src/integration/ai/contract/_engine/signals/verify-skill-proposal/schema.ts';
import { skillSuggestionsSignalSchema } from '@src/integration/ai/contract/_engine/signals/skill-suggestions/schema.ts';
import { contextCompactedSignalSchema } from '@src/integration/ai/contract/_engine/signals/context-compacted/schema.ts';
import { prContentSignalSchema } from '@src/integration/ai/contract/_engine/signals/pr-content/schema.ts';

const ts = '2026-05-22T10:00:00.000Z';

/**
 * Per-kind happy-path parses — ensures every schema validates a canonical example. Edge
 * cases (missing optional fields, wrong types) are exercised by `validate-signals-file.test.ts`
 * via the leaf contracts; this file's only job is to keep each schema's shape under test
 * and prevent silent imports-only references that confuse the dead-code detector.
 */
describe('signal schemas (happy-path parses)', () => {
  it('change', () => {
    expect(changeSignalSchema.safeParse({ type: 'change', text: 'added foo', timestamp: ts }).success).toBe(true);
  });
  it('decision', () => {
    expect(decisionSignalSchema.safeParse({ type: 'decision', text: 'we go with X', timestamp: ts }).success).toBe(
      true
    );
  });
  it('learning', () => {
    expect(learningSignalSchema.safeParse({ type: 'learning', text: 'gotcha', timestamp: ts }).success).toBe(true);
  });
  it('note', () => {
    expect(noteSignalSchema.safeParse({ type: 'note', text: 'just noting', timestamp: ts }).success).toBe(true);
  });
  it('progress (short-form)', () => {
    expect(progressSignalSchema.safeParse({ type: 'progress', summary: 'did x', timestamp: ts }).success).toBe(true);
  });
  it('progress-entry', () => {
    expect(
      progressEntrySignalSchema.safeParse({
        type: 'progress-entry',
        task: 'T1',
        filesChanged: [],
        learnings: '',
        notesForNext: '',
        timestamp: ts,
      }).success
    ).toBe(true);
  });
  it('evaluation: PASS verdict with all dimensions passed', () => {
    expect(
      evaluationSignalSchema.safeParse({
        type: 'evaluation',
        status: 'passed',
        dimensions: [{ dimension: 'correctness', passed: true, finding: '' }],
        timestamp: ts,
      }).success
    ).toBe(true);
  });

  it('evaluation: FAIL with one failing dimension + finding + executionEvidence', () => {
    expect(
      evaluationSignalSchema.safeParse({
        type: 'evaluation',
        status: 'failed',
        dimensions: [
          {
            dimension: 'correctness',
            passed: false,
            finding: 'test failed at src/foo.ts:23',
            executionEvidence: 'npm test\n  1 failing',
          },
        ],
        critique: 'fix src/foo.ts:23',
        timestamp: ts,
      }).success
    ).toBe(true);
  });

  it('evaluation: silently strips the legacy `score` field on a dimension', () => {
    const r = evaluationSignalSchema.safeParse({
      type: 'evaluation',
      status: 'passed',
      dimensions: [{ dimension: 'correctness', score: 5, passed: true, finding: '' }],
      timestamp: ts,
    });
    // Zod's non-strict object passes the parse but drops the unknown `score` key on output —
    // the canonical shape is restored downstream so renderers / persistence don't have to
    // special-case the legacy field.
    expect(r.success).toBe(true);
    if (r.success) {
      const dim = r.data.dimensions[0];
      if (dim !== undefined) {
        expect((dim as Record<string, unknown>)['score']).toBeUndefined();
      }
    }
  });

  it('evaluation: silently strips the legacy `overallScore` field on the signal', () => {
    const r = evaluationSignalSchema.safeParse({
      type: 'evaluation',
      status: 'passed',
      dimensions: [{ dimension: 'correctness', passed: true, finding: '' }],
      overallScore: 5,
      timestamp: ts,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>)['overallScore']).toBeUndefined();
    }
  });

  it('evaluation: rejects a failed-status signal whose every dimension passed', () => {
    const r = evaluationSignalSchema.safeParse({
      type: 'evaluation',
      status: 'failed',
      dimensions: [{ dimension: 'correctness', passed: true, finding: '' }],
      timestamp: ts,
    });
    expect(r.success).toBe(false);
  });

  it('evaluation: rejects a passed-status signal carrying a failing dimension', () => {
    const r = evaluationSignalSchema.safeParse({
      type: 'evaluation',
      status: 'passed',
      dimensions: [{ dimension: 'correctness', passed: false, finding: 'oops' }],
      timestamp: ts,
    });
    expect(r.success).toBe(false);
  });

  it('evaluation: rejects a failed dimension with no finding', () => {
    const r = evaluationSignalSchema.safeParse({
      type: 'evaluation',
      status: 'failed',
      dimensions: [{ dimension: 'correctness', passed: false, finding: '' }],
      timestamp: ts,
    });
    expect(r.success).toBe(false);
  });
  it('commit-message', () => {
    expect(
      commitMessageSignalSchema.safeParse({ type: 'commit-message', subject: 'feat: x', timestamp: ts }).success
    ).toBe(true);
  });
  it('task-verified', () => {
    expect(taskVerifiedSignalSchema.safeParse({ type: 'task-verified', output: 'green', timestamp: ts }).success).toBe(
      true
    );
  });
  it('task-complete', () => {
    expect(taskCompleteSignalSchema.safeParse({ type: 'task-complete', timestamp: ts }).success).toBe(true);
  });
  it('task-blocked', () => {
    expect(
      taskBlockedSignalSchema.safeParse({ type: 'task-blocked', reason: 'needs spec', timestamp: ts }).success
    ).toBe(true);
  });
  it('agents-md-proposal', () => {
    expect(
      agentsMdProposalSignalSchema.safeParse({
        type: 'agents-md-proposal',
        tag: 'claude-md',
        content: 'body',
        timestamp: ts,
      }).success
    ).toBe(true);
  });
  it('setup-script', () => {
    expect(setupScriptSignalSchema.safeParse({ type: 'setup-script', command: 'pnpm i', timestamp: ts }).success).toBe(
      true
    );
  });
  it('verify-script', () => {
    expect(
      verifyScriptSignalSchema.safeParse({ type: 'verify-script', command: 'pnpm test', timestamp: ts }).success
    ).toBe(true);
  });
  it('setup-skill-proposal', () => {
    expect(
      setupSkillProposalSignalSchema.safeParse({ type: 'setup-skill-proposal', content: '...', timestamp: ts }).success
    ).toBe(true);
  });
  it('verify-skill-proposal', () => {
    expect(
      verifySkillProposalSignalSchema.safeParse({ type: 'verify-skill-proposal', content: '...', timestamp: ts })
        .success
    ).toBe(true);
  });
  it('skill-suggestions', () => {
    expect(
      skillSuggestionsSignalSchema.safeParse({ type: 'skill-suggestions', names: ['react-patterns'], timestamp: ts })
        .success
    ).toBe(true);
  });
  it('context-compacted', () => {
    expect(contextCompactedSignalSchema.safeParse({ type: 'context-compacted', timestamp: ts }).success).toBe(true);
  });
  it('pr-content', () => {
    expect(
      prContentSignalSchema.safeParse({
        type: 'pr-content',
        title: 'Add CSV export',
        body: 'body content',
        timestamp: ts,
      }).success
    ).toBe(true);
  });
});
