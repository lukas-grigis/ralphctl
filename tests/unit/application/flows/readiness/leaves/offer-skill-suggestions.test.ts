import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { offerSkillSuggestionsLeaf } from '@src/application/flows/readiness/leaves/offer-skill-suggestions.ts';
import { absolutePath, FIXED_PROJECT_ID, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const TOOL = 'claude-code' as const;
const REPO = makeRepository({ name: 'svc', path: '/tmp/offer-skill-repo' });

const bundledSkill = (name: string): Skill => ({
  name,
  description: `${name} description`,
  content: `# ${name}\n\nbundled body`,
});

/** SkillSource whose `getByName` knows only the names in `known`. */
const fakeSource = (known: Record<string, Skill>): SkillSource => ({
  async getForFlow() {
    return Result.ok([]);
  },
  async getByName(name: string) {
    return Result.ok(known[name]);
  },
});

interface RecordingAdapter extends SkillsAdapter {
  readonly bareInstalls: ReadonlyArray<{ sessionDir: string; skill: Skill }>;
}

const recordingAdapter = (): RecordingAdapter => {
  const bareInstalls: Array<{ sessionDir: string; skill: Skill }> = [];
  return {
    bareInstalls,
    install: async () => Result.ok(undefined),
    installBareSkill: async (sessionDir: AbsolutePath, skill: Skill) => {
      bareInstalls.push({ sessionDir: String(sessionDir), skill });
      return Result.ok(undefined);
    },
    uninstall: async () => Result.ok(undefined),
    describeSkillsConvention: () => 'test',
  };
};

interface RecordingPrompt extends InteractivePrompt {
  readonly confirmMessages: readonly string[];
}

/** InteractivePrompt that answers `askConfirm` from a scripted queue (in order). */
const scriptedPrompt = (answers: ReadonlyArray<Result<boolean, DomainError>>): RecordingPrompt => {
  const confirmMessages: string[] = [];
  let idx = 0;
  return {
    confirmMessages,
    async askText() {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askText not scripted' }));
    },
    async askTextArea() {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askTextArea not scripted' }));
    },
    async askChoice<T>() {
      return Result.error(
        new ValidationError({ field: 'fake', value: null, message: 'askChoice not scripted' })
      ) as Result<T, DomainError>;
    },
    async askMultiChoice<T>() {
      return Result.ok([]) as Result<readonly T[], DomainError>;
    },
    async askConfirm(input) {
      confirmMessages.push(input.message);
      const answer = answers[idx];
      idx += 1;
      return (
        answer ?? Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted confirm' }))
      );
    },
  };
};

/**
 * Build a ReadinessCtx whose claude-code proposal carries the given skill suggestions.
 * `accepted` defaults to `true` (the operator approved the readiness proposal for this tool);
 * pass `false` to exercise the declined-proposal no-op.
 */
const ctxWith = (suggestions: readonly string[] | undefined, accepted = true): ReadinessCtx => ({
  projectId: FIXED_PROJECT_ID,
  repository: REPO,
  tools: [TOOL],
  entries: {
    [TOOL]: {
      accepted,
      proposal: {
        proposedContent: '# context',
        targetPath: absolutePath('/tmp/offer-skill-repo/CLAUDE.md'),
        ...(suggestions !== undefined ? { proposedSkillSuggestions: suggestions } : {}),
      },
    },
  },
});

describe('offer-skill-suggestions leaf', () => {
  it('reads the suggestions off ctx and offers each one (signal lands on ctx → leaf input)', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([Result.ok(false), Result.ok(false)]);
    const leaf = offerSkillSuggestionsLeaf(
      { interactive: prompt, skillSource: fakeSource({}), skillsAdapter: adapter, logger: noopLogger },
      TOOL
    );

    const out = await leaf.execute(ctxWith(['react-patterns', 'pnpm']));

    expect(out.ok).toBe(true);
    // One confirm per suggestion — proves the ctx suggestions reached the use case.
    expect(prompt.confirmMessages).toHaveLength(2);
    expect(prompt.confirmMessages[0]).toContain('react-patterns');
    expect(prompt.confirmMessages[1]).toContain('pnpm');
  });

  it('bundled suggestion accepted → installs the canonical bundled body', async () => {
    const adapter = recordingAdapter();
    const skill = bundledSkill('ralphctl-alignment');
    const prompt = scriptedPrompt([Result.ok(true)]);
    const leaf = offerSkillSuggestionsLeaf(
      {
        interactive: prompt,
        skillSource: fakeSource({ 'ralphctl-alignment': skill }),
        skillsAdapter: adapter,
        logger: noopLogger,
      },
      TOOL
    );

    const out = await leaf.execute(ctxWith(['ralphctl-alignment']));

    expect(out.ok).toBe(true);
    expect(prompt.confirmMessages[0]).toMatch(/bundled skill 'ralphctl-alignment'/u);
    expect(adapter.bareInstalls).toHaveLength(1);
    expect(adapter.bareInstalls[0]?.sessionDir).toBe(String(REPO.path));
    // Installed body is the canonical bundled skill, not a stub.
    expect(adapter.bareInstalls[0]?.skill).toEqual(skill);
  });

  it('unknown suggestion accepted → scaffolds a minimal-frontmatter stub', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([Result.ok(true)]);
    const leaf = offerSkillSuggestionsLeaf(
      { interactive: prompt, skillSource: fakeSource({}), skillsAdapter: adapter, logger: noopLogger },
      TOOL
    );

    const out = await leaf.execute(ctxWith(['react-patterns']));

    expect(out.ok).toBe(true);
    expect(prompt.confirmMessages[0]).toMatch(/unknown skill 'react-patterns'/u);
    expect(adapter.bareInstalls).toHaveLength(1);
    const stub = adapter.bareInstalls[0]?.skill;
    expect(stub?.name).toBe('react-patterns');
    expect(stub?.description.length).toBeGreaterThan(0);
    expect(stub?.content).toContain('react-patterns');
  });

  it('declined suggestion → no install (human gate is mandatory)', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([Result.ok(false)]);
    const leaf = offerSkillSuggestionsLeaf(
      {
        interactive: prompt,
        skillSource: fakeSource({ 'ralphctl-alignment': bundledSkill('ralphctl-alignment') }),
        skillsAdapter: adapter,
        logger: noopLogger,
      },
      TOOL
    );

    const out = await leaf.execute(ctxWith(['ralphctl-alignment']));

    expect(out.ok).toBe(true);
    expect(prompt.confirmMessages).toHaveLength(1);
    expect(adapter.bareInstalls).toHaveLength(0);
  });

  it('declined proposal (accepted=false) → no prompt, no install even with suggestions', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([]);
    const leaf = offerSkillSuggestionsLeaf(
      {
        interactive: prompt,
        skillSource: fakeSource({ 'ralphctl-alignment': bundledSkill('ralphctl-alignment') }),
        skillsAdapter: adapter,
        logger: noopLogger,
      },
      TOOL
    );

    // Suggestions are present, but the operator declined the overall readiness proposal — the
    // leaf must no-op without firing a single install prompt (consistent with write / install).
    const out = await leaf.execute(ctxWith(['ralphctl-alignment'], false));

    expect(out.ok).toBe(true);
    expect(prompt.confirmMessages).toHaveLength(0);
    expect(adapter.bareInstalls).toHaveLength(0);
  });

  it('empty suggestions → no prompt, no install (no-op)', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([]);
    const leaf = offerSkillSuggestionsLeaf(
      { interactive: prompt, skillSource: fakeSource({}), skillsAdapter: adapter, logger: noopLogger },
      TOOL
    );

    // No `proposedSkillSuggestions` on the proposal → leaf no-ops.
    const out = await leaf.execute(ctxWith(undefined));

    expect(out.ok).toBe(true);
    expect(prompt.confirmMessages).toHaveLength(0);
    expect(adapter.bareInstalls).toHaveLength(0);
  });

  it('mixed accept/decline across suggestions → installs only the accepted ones', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([Result.ok(true), Result.ok(false), Result.ok(true)]);
    const leaf = offerSkillSuggestionsLeaf(
      { interactive: prompt, skillSource: fakeSource({}), skillsAdapter: adapter, logger: noopLogger },
      TOOL
    );

    const out = await leaf.execute(ctxWith(['a-skill', 'b-skill', 'c-skill']));

    expect(out.ok).toBe(true);
    expect(adapter.bareInstalls.map((i) => i.skill.name)).toEqual(['a-skill', 'c-skill']);
  });

  it('propagates an AbortError from the confirm prompt (Ctrl-C aborts the chain)', async () => {
    const adapter = recordingAdapter();
    const prompt = scriptedPrompt([
      Result.error(new AbortError({ elementName: 'offer-skill-suggestions-claude-code' })),
    ]);
    const leaf = offerSkillSuggestionsLeaf(
      { interactive: prompt, skillSource: fakeSource({}), skillsAdapter: adapter, logger: noopLogger },
      TOOL
    );

    const out = await leaf.execute(ctxWith(['react-patterns']));

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.error).toBeInstanceOf(AbortError);
    expect(adapter.bareInstalls).toHaveLength(0);
  });
});
