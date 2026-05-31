/**
 * Multi-provider readiness fan-out tests.
 *
 * Verify that {@link createReadinessFlow} fans out over the unique providers referenced across
 * `settings.ai`'s five per-flow rows — one native context file per unique provider, exactly
 * one when all rows agree, zero new writes when a provider was removed since the prior run.
 */

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { ReadinessProbe, ReadinessProbeRegistry } from '@src/integration/ai/readiness/_engine/probe.ts';
import { absentState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ToolArtifacts } from '@src/integration/ai/readiness/_engine/tool-artifacts.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AgentsMdProposalSignal, SkillSuggestionsSignal } from '@src/domain/signal.ts';
import type { AiSettings } from '@src/domain/entity/settings.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { absolutePath, FIXED_NOW, isoTimestamp, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createReadinessFlow } from '@src/application/flows/readiness/flow.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-readiness-cwd');

/**
 * Project repo fake that resolves `findById` and records every `save()` so tests can assert the
 * `persist-suggested-skills` terminal leaf wrote `Repository.suggestedSkills`.
 */
const fakeProjectRepo = (project: Project): { repo: ProjectRepository; saved: Project[] } => {
  const saved: Project[] = [];
  const repo = {
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
    async save(p: Project) {
      saved.push(p);
      return Result.ok(undefined);
    },
  } as ProjectRepository;
  return { repo, saved };
};

/**
 * Probe registry returning `absent` for every tool we ask about. Fan-out tests only care
 * that the chain runs each tool's probe leaf without crashing — the probe outcome itself is
 * uninteresting.
 */
const universalAbsentProbes = (): ReadinessProbeRegistry => {
  const tools: readonly AssistantTool[] = ['claude-code', 'copilot', 'codex'];
  const entries: Partial<Record<AssistantTool, ReadinessProbe<ToolArtifacts>>> = {};
  for (const tool of tools) {
    entries[tool] = {
      tool,
      async evaluate() {
        return Result.ok(absentState(FIXED_NOW));
      },
    };
  }
  return entries as ReadinessProbeRegistry;
};

interface ScriptedAnswers {
  readonly confirms?: readonly boolean[];
}

const scriptedInteractive = (answers: ScriptedAnswers): InteractivePrompt => {
  let confirmIdx = 0;
  return {
    async askText(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askText not scripted' }));
    },
    async askTextArea(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askTextArea not scripted' }));
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      return Result.error(
        new ValidationError({ field: 'fake', value: null, message: 'askChoice not scripted' })
      ) as Result<T, DomainError>;
    },
    async askConfirm(): Promise<Result<boolean, DomainError>> {
      const value = answers.confirms?.[confirmIdx];
      confirmIdx += 1;
      if (value === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted confirm' }));
      return Result.ok(value);
    },
    async askMultiChoice<T>(): Promise<Result<readonly T[], DomainError>> {
      return Result.ok([]);
    },
  };
};

const agentsMdProposal = (content: string): AgentsMdProposalSignal => ({
  type: 'agents-md-proposal',
  tag: 'claude-md',
  content,
  timestamp: IsoTimestamp.now(),
});

const skillSuggestions = (names: readonly string[]): SkillSuggestionsSignal => ({
  type: 'skill-suggestions',
  names,
  timestamp: IsoTimestamp.now(),
});

/** Skills adapter that records every `installBareSkill` call so tests can assert the gate. */
const recordingSkillsAdapter = (): { adapter: SkillsAdapter; bareInstalls: Array<{ dir: string; skill: Skill }> } => {
  const bareInstalls: Array<{ dir: string; skill: Skill }> = [];
  const adapter: SkillsAdapter = {
    install: async () => Result.ok(undefined),
    installBareSkill: async (dir, skill) => {
      bareInstalls.push({ dir: String(dir), skill });
      return Result.ok(undefined);
    },
    uninstall: async () => Result.ok(undefined),
    describeSkillsConvention: () => 'test',
  };
  return { adapter, bareInstalls };
};

const recordingWriteFile = (): { write: WriteFile; writes: Array<{ path: string; content: string }> } => {
  const writes: Array<{ path: string; content: string }> = [];
  const write: WriteFile = async (path, content) => {
    writes.push({ path: String(path), content });
    return Result.ok(undefined);
  };
  return { write, writes };
};

/**
 * Settings builder — six per-flow rows pointing at the requested per-flow providers. Models
 * are valid catalog entries for each provider so the discriminated union accepts the record.
 * `createPr` mirrors refine's provider — the row was added late; tests that don't care about
 * it just inherit refine's choice.
 */
const buildAi = (per: {
  refine: 'claude-code' | 'github-copilot' | 'openai-codex';
  plan: 'claude-code' | 'github-copilot' | 'openai-codex';
  implement: 'claude-code' | 'github-copilot' | 'openai-codex';
  readiness: 'claude-code' | 'github-copilot' | 'openai-codex';
  ideate: 'claude-code' | 'github-copilot' | 'openai-codex';
}): AiSettings => {
  const rowFor = (provider: 'claude-code' | 'github-copilot' | 'openai-codex'): AiSettings['refine'] => {
    if (provider === 'claude-code') return { provider, model: 'claude-sonnet-4-6' };
    if (provider === 'github-copilot') return { provider, model: 'claude-sonnet-4.5' };
    return { provider, model: 'gpt-5.3-codex' };
  };
  return {
    refine: rowFor(per.refine),
    plan: rowFor(per.plan),
    implement: { generator: rowFor(per.implement), evaluator: rowFor(per.implement) },
    readiness: rowFor(per.readiness),
    ideate: rowFor(per.ideate),
    createPr: rowFor(per.refine),
  };
};

describe('readiness fan-out across unique providers', () => {
  let tmpDir: string;
  let repoPath: string;
  let runsRoot: AbsolutePath;

  beforeEach(async () => {
    const raw = await fs.mkdtemp('/tmp/ralphctl-readiness-fanout-test-');
    tmpDir = await realpath(raw);
    repoPath = join(tmpDir, 'repo-a');
    await fs.mkdir(repoPath, { recursive: true });
    const parsed = AbsolutePath.parse(join(tmpDir, 'runs'));
    if (!parsed.ok) throw new Error('AbsolutePath.parse failed for runs dir');
    runsRoot = parsed.value;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const buildScene = async () => {
    const repository = makeRepository({ path: repoPath, name: 'repo-a' });
    const project = makeProject({ repositories: [repository] });
    return { project, repository };
  };

  /**
   * Pull the per-tool target-write paths out of the recorded writes (filter out the
   * audit-[09] sidecar writes that land under the engine's per-run forensic dir).
   */
  const filterTargetWrites = (
    writes: ReadonlyArray<{ path: string; content: string }>
  ): ReadonlyArray<{ path: string; content: string }> => writes.filter((w) => !w.path.includes('/runs/readiness/'));

  it('three providers across flows → three native context files written', async () => {
    const { project, repository } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();

    // One provider instance shared across all three tool sub-chains — the fake just writes
    // signals.json on every call.
    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n')] },
    });
    const interactive = scriptedInteractive({ confirms: [true, true, true] });

    const ai = buildAi({
      refine: 'github-copilot',
      plan: 'openai-codex',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'github-copilot',
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project).repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-3',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const targets = new Set(filterTargetWrites(writer.writes).map((w) => w.path));
    expect(targets).toEqual(
      new Set([
        join(String(repository.path), 'CLAUDE.md'),
        join(String(repository.path), '.github', 'copilot-instructions.md'),
        join(String(repository.path), 'AGENTS.md'),
      ])
    );
  });

  it('two providers across flows → exactly two native context files written', async () => {
    const { project, repository } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n')] },
    });
    const interactive = scriptedInteractive({ confirms: [true, true] });

    const ai = buildAi({
      refine: 'claude-code',
      plan: 'github-copilot',
      implement: 'claude-code',
      readiness: 'github-copilot',
      ideate: 'claude-code',
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project).repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-2',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const targets = new Set(filterTargetWrites(writer.writes).map((w) => w.path));
    expect(targets).toEqual(
      new Set([
        join(String(repository.path), 'CLAUDE.md'),
        join(String(repository.path), '.github', 'copilot-instructions.md'),
      ])
    );
    // Codex's AGENTS.md must NOT appear — no row references openai-codex.
    expect(targets.has(join(String(repository.path), 'AGENTS.md'))).toBe(false);
  });

  it('all five flows on claude-code → exactly CLAUDE.md written', async () => {
    const { project, repository } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n')] },
    });
    const interactive = scriptedInteractive({ confirms: [true] });

    const ai = buildAi({
      refine: 'claude-code',
      plan: 'claude-code',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'claude-code',
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project).repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-claude-only',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const targets = filterTargetWrites(writer.writes).map((w) => w.path);
    expect(targets).toEqual([join(String(repository.path), 'CLAUDE.md')]);
    // Neither Copilot's nor Codex's native file should land.
    expect(targets.some((p) => p.endsWith('copilot-instructions.md'))).toBe(false);
    expect(targets.some((p) => p.endsWith('AGENTS.md'))).toBe(false);
  });

  it('provider removed from all rows → previously-written file on disk is untouched', async () => {
    // Simulate a prior successful readiness run that wrote AGENTS.md, then the user removes
    // every Codex reference from settings.ai. The second readiness run must NOT touch the
    // existing AGENTS.md (the chain doesn't even probe / propose for Codex anymore).
    const { project, repository } = await buildScene();
    const existingAgentsMd = join(String(repository.path), 'AGENTS.md');
    const originalContent = '# AGENTS.md authored in a prior readiness run\n';
    await fs.writeFile(existingAgentsMd, originalContent, 'utf8');

    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n')] },
    });
    const interactive = scriptedInteractive({ confirms: [true] });

    // After the cleanup: every flow now runs on claude-code, no row references openai-codex.
    const ai = buildAi({
      refine: 'claude-code',
      plan: 'claude-code',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'claude-code',
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project).repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-removed',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    // The pre-existing AGENTS.md on disk was not overwritten by this readiness run.
    const onDisk = await fs.readFile(existingAgentsMd, 'utf8');
    expect(onDisk).toBe(originalContent);

    // The recording writer saw no writes targeting AGENTS.md.
    const targets = filterTargetWrites(writer.writes).map((w) => w.path);
    expect(targets).toEqual([join(String(repository.path), 'CLAUDE.md')]);
    expect(targets.includes(existingAgentsMd)).toBe(false);
  });

  it('skill-suggestions signal projects onto ctx and an accepted unknown suggestion is stubbed', async () => {
    const { project, repository } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();
    const { adapter, bareInstalls } = recordingSkillsAdapter();

    // AI emits the context-file proposal plus one unknown skill suggestion.
    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n'), skillSuggestions(['react-patterns'])] },
    });
    // First confirm → confirm-claude-code (apply proposal); second → offer-skill-suggestions.
    const interactive = scriptedInteractive({ confirms: [true, true] });

    const ai = buildAi({
      refine: 'claude-code',
      plan: 'claude-code',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'claude-code',
    });

    const { repo, saved } = fakeProjectRepo(project);
    const flow = createReadinessFlow(
      {
        projectRepo: repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => adapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-skill-suggestions',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    // Propose leaf projected the suggestion names onto the proposal slot.
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedSkillSuggestions).toEqual(['react-patterns']);

    // emptySkillSource → react-patterns is unknown → scaffolded as a stub into the repo path.
    expect(bareInstalls).toHaveLength(1);
    expect(bareInstalls[0]?.dir).toBe(String(repository.path));
    expect(bareInstalls[0]?.skill.name).toBe('react-patterns');
    expect(bareInstalls[0]?.skill.content).toContain('react-patterns');

    // persist-suggested-skills ran once and recorded the offered suggestion on the repository.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.repositories[0]?.suggestedSkills).toEqual(['react-patterns']);
  });

  it('declined proposal with skill-suggestions → no offer prompt, but suggestion still persisted', async () => {
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();
    const { adapter, bareInstalls } = recordingSkillsAdapter();

    // AI emits the proposal plus an unknown skill suggestion, but the operator DECLINES the
    // overall proposal at confirm-claude-code. The offer leaf must then no-op — declining the
    // proposal declines its suggested skills, so no install prompt fires.
    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n'), skillSuggestions(['react-patterns'])] },
    });
    // Single confirm → confirm-claude-code answered `false`. If the offer leaf still prompted,
    // the scripted prompt would run dry and the chain would fail — proving the gate works.
    const interactive = scriptedInteractive({ confirms: [false] });

    const ai = buildAi({
      refine: 'claude-code',
      plan: 'claude-code',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'claude-code',
    });

    const { repo, saved } = fakeProjectRepo(project);
    const flow = createReadinessFlow(
      {
        projectRepo: repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => adapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-declined-suggestions',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.entries['claude-code']?.accepted).toBe(false);
    // Proposal projected the suggestion, but the declined proposal gates the offer leaf.
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedSkillSuggestions).toEqual(['react-patterns']);
    expect(bareInstalls).toHaveLength(0);
    // persist-suggested-skills is NOT gated on accept — the declined proposal still leaves a
    // durable record of what was recommended.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.repositories[0]?.suggestedSkills).toEqual(['react-patterns']);
  });

  it('empty skill-suggestions → no prompt consumed, no stub written', async () => {
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();
    const { adapter, bareInstalls } = recordingSkillsAdapter();

    // Empty `names` is the canonical "no suggestions" state — offer leaf must no-op.
    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n'), skillSuggestions([])] },
    });
    // Only the confirm-claude-code prompt should fire; offer leaf consumes none.
    const interactive = scriptedInteractive({ confirms: [true] });

    const ai = buildAi({
      refine: 'claude-code',
      plan: 'claude-code',
      implement: 'claude-code',
      readiness: 'claude-code',
      ideate: 'claude-code',
    });

    const { repo, saved } = fakeProjectRepo(project);
    const flow = createReadinessFlow(
      {
        projectRepo: repo,
        probes: universalAbsentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => adapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai }
    );

    const runner = createRunner({
      id: 'r-fanout-empty-suggestions',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    // Empty names → no projection onto ctx, no stub.
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedSkillSuggestions).toBeUndefined();
    expect(bareInstalls).toHaveLength(0);
    // persist-suggested-skills is a no-op when there are zero suggestions — no save fires.
    expect(saved).toHaveLength(0);
  });
});
