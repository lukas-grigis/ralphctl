import { describe, expect, it } from 'vitest';
import { buildPromptPointer } from '@src/integration/ai/providers/_engine/prompt-pointer.ts';

describe('buildPromptPointer', () => {
  it('names the prompt file and stays a single line', () => {
    const pointer = buildPromptPointer('/tmp/run/prompt.md');
    expect(pointer).toContain('/tmp/run/prompt.md');
    expect(pointer).not.toMatch(/[\r\n]/);
  });

  it('does not tell the AI there is nothing to ask about — interactive briefs put questions to the operator', () => {
    const pointer = buildPromptPointer('/tmp/run/prompt.md');
    expect(pointer).not.toContain('nothing further to wait for or ask about');
    expect(pointer).toContain('questions or approvals');
  });
});
