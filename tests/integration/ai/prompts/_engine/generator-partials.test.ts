import { describe, expect, it } from 'vitest';
import { applyFeedbackPromptDef } from '@src/integration/ai/prompts/apply-feedback/definition.ts';
import { implementPromptDef } from '@src/integration/ai/prompts/implement/definition.ts';
import { implementContinuationPromptDef } from '@src/integration/ai/prompts/implement-continuation/definition.ts';
import { implementCrashResumePromptDef } from '@src/integration/ai/prompts/implement-crash-resume/definition.ts';
import { reproducePromptDef } from '@src/integration/ai/prompts/reproduce/definition.ts';

describe('generator-side shared partials', () => {
  it.each([
    ['implement', implementPromptDef],
    ['implement-continuation', implementContinuationPromptDef],
    ['implement-crash-resume', implementCrashResumePromptDef],
    ['reproduce', reproducePromptDef],
    ['apply-feedback', applyFeedbackPromptDef],
  ])('%s declares git-boundary', (_name, def) => {
    expect(def.partials?.['GIT_BOUNDARY']).toBe('git-boundary');
  });

  it.each([
    ['implement', implementPromptDef],
    ['implement-continuation', implementContinuationPromptDef],
    ['implement-crash-resume', implementCrashResumePromptDef],
  ])('%s declares task-blocked', (_name, def) => {
    expect(def.partials?.['TASK_BLOCKED']).toBe('task-blocked');
  });
});
