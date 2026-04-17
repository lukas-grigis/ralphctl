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
import { TextPromptBuilderAdapter } from './prompt-builder-adapter.ts';

describe('TextPromptBuilderAdapter', () => {
  describe('buildTaskExecutionPrompt', () => {
    const adapter = new TextPromptBuilderAdapter();
    const progressFilePath = '/tmp/sprint-abc/progress.md';
    const contextFileName = '.ralphctl-sprint-abc-task-t1-context.md';

    it('renders the progress file path where {{PROGRESS_FILE}} was', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, false);
      expect(out).toContain(progressFilePath);
      expect(out).not.toContain('{{PROGRESS_FILE}}');
    });

    it('renders the context file name where {{CONTEXT_FILE}} was', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, false);
      expect(out).toContain(contextFileName);
      expect(out).not.toContain('{{CONTEXT_FILE}}');
    });

    it('does NOT render `false` into the prompt when noCommit is false — argument order guard', () => {
      // If the adapter accidentally swaps `contextFileName` and `noCommit`
      // (as it did once), the loader receives `false` as the context file
      // name and the rendered prompt reads "Implement the task described
      // in false." — this assertion would catch that.
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, false);
      expect(out).not.toMatch(/described in false\b/);
      expect(out).not.toMatch(/Leave false\b/);
    });

    it('includes the commit instructions by default', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName);
      expect(out).toContain('git commit');
    });

    it('omits commit instructions when noCommit is true', () => {
      const out = adapter.buildTaskExecutionPrompt(progressFilePath, contextFileName, true);
      expect(out).not.toContain('git commit');
      expect(out).not.toContain('Must commit');
    });
  });
});
