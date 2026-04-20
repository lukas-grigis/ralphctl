/**
 * Adapter-level tests for the prompt builder.
 *
 * The adapter is a thin bridge between the `PromptBuilderPort` (business
 * port) and the concrete loader functions (`loader.ts`). The critical
 * property under test: port arguments arrive at the loader in the right
 * positional order — a regression we actually shipped once, where the
 * adapter smuggled context markdown through the `progressFilePath` slot
 * and rendered `{{PROGRESS_FILE}}` as a wall of text.
 */

import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/models.ts';
import { TextPromptBuilderAdapter } from './prompt-builder-adapter.ts';

describe('TextPromptBuilderAdapter', () => {
  describe('buildTaskExecutionPrompt', () => {
    const adapter = new TextPromptBuilderAdapter();
    const progressFilePath = '/tmp/sprint-abc/progress.md';
    const contextFileName = '.ralphctl-sprint-abc-task-t1-context.md';

    it('renders the progress file path where {{PROGRESS_FILE}} was', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, '', false);
      expect(out).toContain(progressFilePath);
      expect(out).not.toContain('{{PROGRESS_FILE}}');
    });

    it('renders the context file name where {{CONTEXT_FILE}} was', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, '', false);
      expect(out).toContain(contextFileName);
      expect(out).not.toContain('{{CONTEXT_FILE}}');
    });

    it('does NOT render `false` into the prompt when noCommit is false — argument order guard', () => {
      // If the adapter accidentally swaps `contextFileName` and `noCommit`
      // (as it did once), the loader receives `false` as the context file
      // name and the rendered prompt reads "Implement the task described
      // in false." — this assertion would catch that.
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, '', false);
      expect(out).not.toMatch(/described in false\b/);
      expect(out).not.toMatch(/Leave false\b/);
    });

    it('includes the commit instructions by default', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, '');
      expect(out).toContain('git commit');
    });

    it('omits commit instructions when noCommit is true', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, '', true);
      expect(out).not.toContain('git commit');
      expect(out).not.toContain('Must commit');
    });

    it('renders the project tooling section when supplied', () => {
      const tooling = '## Project Tooling\n\n### Subagents available\n- `auditor`';
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, tooling, false);
      expect(out).toContain('Project Tooling');
      expect(out).toContain('auditor');
    });
  });

  describe('buildTaskEvaluationPrompt', () => {
    const adapter = new TextPromptBuilderAdapter();
    const task: Task = {
      id: 't1',
      name: 'Evaluator test task',
      description: 'desc',
      steps: ['Step one', 'Step two'],
      verificationCriteria: ['Criterion A'],
      status: 'done',
      order: 1,
      blockedBy: [],
      repoId: 'repo0001',
      verified: true,
      evaluated: false,
    };
    const repoPath = '/tmp/repo';
    it('renders the check-script section when supplied and never the literal "null"', () => {
      // Regression guard: this method previously hardcoded
      // `checkScriptSection: null` inside the adapter, so the evaluator
      // never saw the resolved `checkScript`. The adapter now forwards
      // whatever the caller supplies — verify both that the text lands in
      // the prompt AND that the prompt never contains the literal JS
      // string "null" (which would indicate a regression to the old
      // hardcoded path).
      const checkScriptSection = '## Check Script (Computational Gate)\n\nRun `pnpm test` first.';
      const out = adapter.buildTaskEvaluationPrompt(task, repoPath, checkScriptSection, '');
      expect(out).toContain('pnpm test');
      expect(out).toContain('Check Script (Computational Gate)');
      expect(out).not.toMatch(/\bnull\b/);
    });

    it('renders the project tooling section when supplied', () => {
      const projectToolingSection =
        '## Project Tooling (use these — they exist for a reason)\n\nSubagents: auditor, reviewer.';
      const out = adapter.buildTaskEvaluationPrompt(task, repoPath, null, projectToolingSection);
      expect(out).toContain('Project Tooling');
      expect(out).toContain('auditor');
    });

    it('accepts a null check-script section without leaking the word "null" into the prompt', () => {
      const out = adapter.buildTaskEvaluationPrompt(task, repoPath, null, '');
      expect(out).not.toMatch(/\bnull\b/);
    });

    it('flows task.extraDimensions through to the rendered prompt', () => {
      // Adapter must forward planner-emitted dimensions onto the floor four —
      // this is the only path by which task.extraDimensions reaches the
      // evaluator, so the regression we want to guard is the adapter
      // dropping the field on the floor.
      const taskWithExtras: Task = { ...task, extraDimensions: ['Performance'] };
      const out = adapter.buildTaskEvaluationPrompt(taskWithExtras, repoPath, null, '');
      expect(out).toContain('<dimension name="Performance" floor="false">');
    });

    it('omits extra-dimension blocks when task.extraDimensions is undefined', () => {
      // `undefined` (not `[]`) is the floor-only case — the adapter
      // normalises it to an empty array so the loader renders nothing.
      const out = adapter.buildTaskEvaluationPrompt(task, repoPath, null, '');
      expect(out).not.toContain('floor="false"');
    });
  });

  describe('buildFeedbackPrompt', () => {
    const adapter = new TextPromptBuilderAdapter();

    it('renders the feedback text verbatim into the prompt', () => {
      // Regression guard: users reported that free-form feedback appeared to be
      // accepted but the AI never acted on it. The chain only works if the
      // user's words reach the rendered prompt — this assertion locks the
      // contract so a missing `{{FEEDBACK}}` placeholder or a dropped argument
      // in the composer is caught at test time.
      const feedback = 'create hello.md with content "hi"';
      const out = adapter.buildFeedbackPrompt('sprint-name', '- task A (/tmp)', feedback, 'branch');
      expect(out).toContain(feedback);
      expect(out).toContain('sprint-name');
      expect(out).toContain('branch');
      expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
    });

    it('renders without a branch section when branch is null', () => {
      const out = adapter.buildFeedbackPrompt('s', 'c', 'do the thing', null);
      expect(out).toContain('do the thing');
      expect(out).not.toContain('**Branch:**');
      expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
    });
  });
});
