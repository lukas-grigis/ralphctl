import { describe, expect, it } from 'vitest';
import {
  hasAnyClaudeArtifact,
  hasAnyCodexArtifact,
  hasAnyCopilotArtifact,
  isAbsent,
  isPresent,
  isUnknown,
} from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { ClaudeArtifacts } from '@src/integration/ai/readiness/claude/artifacts.ts';
import type { CopilotArtifacts } from '@src/integration/ai/readiness/copilot/artifacts.ts';
import type { CodexArtifacts } from '@src/integration/ai/readiness/codex/artifacts.ts';
import { absentState, presentState, unknownState } from '@src/integration/ai/readiness/_engine/state.ts';
import { absolutePath, FIXED_NOW } from '@tests/fixtures/domain.ts';

const emptyClaude: ClaudeArtifacts = {
  tool: 'claude-code',
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
};

describe('ReadinessState narrowing', () => {
  it('isUnknown / isAbsent / isPresent narrow the union', () => {
    expect(isUnknown(unknownState)).toBe(true);
    expect(isAbsent(absentState(FIXED_NOW))).toBe(true);
    expect(isPresent(presentState(FIXED_NOW, emptyClaude))).toBe(true);

    expect(isPresent(unknownState)).toBe(false);
    expect(isAbsent(unknownState)).toBe(false);
    expect(isUnknown(absentState(FIXED_NOW))).toBe(false);
  });
});

describe('hasAnyClaudeArtifact', () => {
  it('false when every field is empty / undefined', () => {
    expect(hasAnyClaudeArtifact(emptyClaude)).toBe(false);
  });

  it('true with claudeMd present', () => {
    expect(hasAnyClaudeArtifact({ ...emptyClaude, claudeMd: { path: absolutePath('/repo/CLAUDE.md') } })).toBe(true);
  });

  it('true with at least one skill', () => {
    expect(
      hasAnyClaudeArtifact({
        ...emptyClaude,
        skills: [{ name: 'a' as never, path: absolutePath('/repo/.claude/skills/a/SKILL.md') }],
      })
    ).toBe(true);
  });
});

describe('hasAnyCopilotArtifact', () => {
  it('false when copilotInstructions is missing', () => {
    const a: CopilotArtifacts = { tool: 'copilot' };
    expect(hasAnyCopilotArtifact(a)).toBe(false);
  });

  it('true when copilotInstructions is set', () => {
    const a: CopilotArtifacts = {
      tool: 'copilot',
      copilotInstructions: { path: absolutePath('/repo/.github/copilot-instructions.md') },
    };
    expect(hasAnyCopilotArtifact(a)).toBe(true);
  });
});

describe('hasAnyCodexArtifact', () => {
  it('false when agentsMd is missing and skills are empty', () => {
    const a: CodexArtifacts = { tool: 'codex', skills: [] };
    expect(hasAnyCodexArtifact(a)).toBe(false);
  });

  it('true when AGENTS.md exists', () => {
    const a: CodexArtifacts = { tool: 'codex', agentsMd: { path: absolutePath('/repo/AGENTS.md') }, skills: [] };
    expect(hasAnyCodexArtifact(a)).toBe(true);
  });

  it('true when at least one skill exists', () => {
    const a: CodexArtifacts = {
      tool: 'codex',
      skills: [{ name: 'my-skill' as never, path: absolutePath('/repo/.agents/skills/my-skill/SKILL.md') }],
    };
    expect(hasAnyCodexArtifact(a)).toBe(true);
  });
});
