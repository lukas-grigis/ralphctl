import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { ReadinessProbeRegistry, ReadinessProbe } from '@src/integration/ai/readiness/_engine/probe.ts';
import { absentState, type ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
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
import type { AgentsMdProposalSignal } from '@src/domain/signal.ts';
import type { AiSettings } from '@src/domain/entity/settings.ts';
import { absolutePath, FIXED_NOW, isoTimestamp, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createReadinessFlow } from '@src/application/flows/readiness/flow.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import { readinessSession } from '@src/application/flows/readiness/leaves/propose.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-readiness-cwd');

const claudeOnlySettings: AiSettings = {
  refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  plan: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    evaluator: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  },
  readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  createPr: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
};

// ── fakes ────────────────────────────────────────────────────────────────

const fakeProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

/** Single-tool probe registry that returns a scripted state. */
const fakeProbeRegistry = (tool: AssistantTool, state: ReadinessState): ReadinessProbeRegistry => {
  const probe: ReadinessProbe<ToolArtifacts> = {
    tool,
    async evaluate() {
      return Result.ok(state);
    },
  };
  return { [tool]: probe } as ReadinessProbeRegistry;
};

/** Scripted interactive prompt — answers in FIFO order; throws when over-asked. */
interface ScriptedAnswers {
  readonly choices?: readonly unknown[];
  readonly confirms?: readonly boolean[];
  readonly texts?: readonly string[];
}

const scriptedInteractive = (answers: ScriptedAnswers): InteractivePrompt => {
  let choiceIdx = 0;
  let confirmIdx = 0;
  let textIdx = 0;
  return {
    async askText(): Promise<Result<string, DomainError>> {
      const text = answers.texts?.[textIdx];
      textIdx += 1;
      if (text === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted text' }));
      return Result.ok(text);
    },
    async askTextArea(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askTextArea not scripted' }));
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      const value = answers.choices?.[choiceIdx];
      choiceIdx += 1;
      if (value === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted choice' }));
      return Result.ok(value as T) as Result<T, DomainError>;
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

/**
 * Build an `agents-md-proposal` signal — readiness's contract requires exactly one per
 * spawn; tests use this builder to keep the inline signal arrays terse.
 */
const claudeMdProposal = (content: string): AgentsMdProposalSignal => ({
  type: 'agents-md-proposal',
  tag: 'claude-md',
  content,
  timestamp: IsoTimestamp.now(),
});

/**
 * In-memory `WriteFile` adapter that records every write into a Map keyed by absolute path.
 * Tests assert the write order via `writes` (insertion-ordered) and the per-path content.
 */
const recordingWriteFile = (): { write: WriteFile; writes: Array<{ path: string; content: string }> } => {
  const writes: Array<{ path: string; content: string }> = [];
  const write: WriteFile = async (path, content) => {
    writes.push({ path: String(path), content });
    return Result.ok(undefined);
  };
  return {
    write,
    writes,
  };
};

// ── tests ───────────────────────────────────────────────────────────────

describe('createReadinessFlow', () => {
  let tmpDir: string;
  let repoPath: string;
  let runsRoot: AbsolutePath;

  beforeEach(async () => {
    const raw = await fs.mkdtemp('/tmp/ralphctl-readiness-test-');
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

  const buildScene = async (overrides?: { existingFile?: string }) => {
    const repository = makeRepository({ path: repoPath, name: 'repo-a' });
    const project = makeProject({ repositories: [repository] });

    if (overrides?.existingFile !== undefined) {
      await fs.writeFile(join(repoPath, 'CLAUDE.md'), overrides.existingFile, 'utf8');
    }
    return { project, repository };
  };

  it('happy path — probe absent → AI proposes → user accepts → file written at expected path', async () => {
    const { project, repository } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const capturedLogs: Array<{ level: string; message: string }> = [];
    const aiSignals: Array<{ type: string }> = [];
    eventBus.subscribe((e) => {
      if (e.type === 'log') capturedLogs.push({ level: e.level, message: e.message });
      if (e.type === 'ai-signal') aiSignals.push({ type: e.signal.type });
    });
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: {
        readiness: [
          claudeMdProposal('# repo-a\n\n## Build & Run\n- pnpm install\n'),
          { type: 'note', text: 'small repo', timestamp: IsoTimestamp.now() },
        ],
      },
    });

    const interactive = scriptedInteractive({
      // Only the pick-repository step asks; the single-repo project skips its prompt entirely.
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
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
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-1',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-project',
      'pick-repository',
      'probe-claude-code',
      'install-skills-claude-code',
      'allocate-run-dir-claude-code',
      'stamp-meta-claude-code',
      'propose-claude-code',
      'uninstall-skills-claude-code',
      'confirm-claude-code',
      'write-claude-code',
      'install-readiness-skills-claude-code',
    ]);

    // The recorder captures every WriteFile call: the audit-[09] sidecar render writes
    // `agents-md-proposal.md` into the engine's per-run forensic dir, then the write leaf
    // lands the final body at the canonical `<repo>/CLAUDE.md` path.
    const targetWrites = writer.writes.filter((w) => w.path === join(String(repository.path), 'CLAUDE.md'));
    expect(targetWrites).toHaveLength(1);
    expect(targetWrites[0]?.content).toContain('# repo-a');
    expect(targetWrites[0]?.content).toContain('## Build & Run');
    // The harness-owned sidecar lands under the engine's run dir; same body as the signal.
    const sidecarWrites = writer.writes.filter((w) => w.path.endsWith('/agents-md-proposal.md'));
    expect(sidecarWrites).toHaveLength(1);
    expect(sidecarWrites[0]?.content).toContain('# repo-a');

    // The audit-[09] contract fans validated signals out as `ai-signal` events on the bus.
    expect(aiSignals.map((s) => s.type)).toEqual(['agents-md-proposal', 'note']);

    expect(runner.ctx.entries['claude-code']?.accepted).toBe(true);
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedContent).toContain('# repo-a');

    const messages = capturedLogs.map((e) => e.message);
    expect(messages.some((m) => m.includes('starting repo'))).toBe(true);
    expect(messages.some((m) => m.includes('provider spawn complete'))).toBe(true);
    expect(messages.some((m) => m.includes('wrote'))).toBe(true);
  });

  it('AiSession profile — readiness runs read-only with the configured model (no edit, no shell, no auto-approve)', () => {
    const session = readinessSession(
      FAKE_CWD,
      '#prompt' as unknown as Prompt,
      'claude-sonnet-4-6',
      absolutePath('/tmp/run-dir/signals.json'),
      undefined,
      absolutePath('/tmp/run-dir')
    );
    expect(session.model).toBe('claude-sonnet-4-6');
    expect(session.permissions.canModifyRepoFiles).toBe(false);
    expect(session.permissions.canRunShell).toBe(false);
    expect(session.permissions.autoApprove).toBe(false);
    expect(String(session.outputDir)).toBe('/tmp/run-dir');
  });

  it('rejection path — user declines → no file is written', async () => {
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const capturedLogs: Array<{ level: string; message: string }> = [];
    eventBus.subscribe((e) => {
      if (e.type === 'log') capturedLogs.push({ level: e.level, message: e.message });
    });
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [claudeMdProposal('# repo-a\n')] },
    });

    const interactive = scriptedInteractive({
      confirms: [false], // user declines
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
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
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-2',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.entries['claude-code']?.accepted).toBe(false);
    // The write leaf is a no-op on decline, but the audit-[09] sidecar render still writes
    // `agents-md-proposal.md` into the engine's per-run forensic dir BEFORE the confirm step
    // — sidecars are operator UX, written unconditionally on a successful AI round-trip. The
    // final target path (`<repo>/CLAUDE.md`) stays untouched.
    const finalWrites = writer.writes.filter((w) => !w.path.includes('/runs/readiness/'));
    expect(finalWrites).toHaveLength(0);

    const messages = capturedLogs.map((e) => e.message);
    expect(messages.some((m) => m.includes('skipping write'))).toBe(true);
  });

  it('backup path — existing file → writes <target>.bak.<timestamp> before overwriting', async () => {
    const { project, repository } = await buildScene({ existingFile: '# old content\n' });
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [claudeMdProposal('# new content\n')] },
    });

    const interactive = scriptedInteractive({
      confirms: [true],
    });

    // Pin the clock so the backup-suffix is fully deterministic.
    const PINNED = isoTimestamp('2026-05-09T10:00:00.000Z');
    const expectedSuffix = String(PINNED).replace(/:/g, '-');

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => PINNED,
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-3',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const targetPath = join(String(repository.path), 'CLAUDE.md');
    const backupPath = `${targetPath}.bak.${expectedSuffix}`;

    // Filter out the audit-[09] sidecar write (`agents-md-proposal.md` under the engine's
    // per-run forensic dir) so the assertion focuses on the write leaf's backup-then-write
    // pair against the canonical target.
    const finalWrites = writer.writes.filter((w) => !w.path.includes('/runs/readiness/'));
    expect(finalWrites.map((w) => w.path)).toEqual([backupPath, targetPath]);
    expect(finalWrites[0]?.content).toBe('# old content\n');
    expect(finalWrites[1]?.content).toContain('# new content');
  });

  it('surfaces a typed error when probe registry has no matching probe but the chain still completes (unknown state)', async () => {
    // Empty probe registry → evaluateReadiness returns `unknownState`. Chain still flows
    // and the AI is asked to propose a fresh body.
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [claudeMdProposal('# fresh\n')] },
    });

    const interactive = scriptedInteractive({
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes: {}, // no probes registered
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-4',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.entries['claude-code']?.probedState?.kind).toBe('unknown');
    // Audit-[09] adds the sidecar write under the engine's per-run dir; filter to the final
    // target write only.
    const finalWrites = writer.writes.filter((w) => !w.path.includes('/runs/readiness/'));
    expect(finalWrites).toHaveLength(1);
  });

  it('surfaces an InvalidStateError when the AI omits the agents-md-proposal signal', async () => {
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    // The AI returned no proposal signal — emulates a session that couldn't read the repo and
    // bailed without producing anything actionable. The leaf must surface a typed error rather
    // than silently advancing.
    const provider = createFakeAiProvider({
      signals: { readiness: [] },
    });

    const interactive = scriptedInteractive({
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-5',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('failed');
    const failed = runner.trace.find((e) => e.status === 'failed');
    expect(failed?.elementName).toBe('propose-claude-code');
    // The upstream stamp-meta leaf writes meta.json before propose runs (intentional —
    // attribution survives propose-side failures). Nothing else lands on disk.
    expect(writer.writes.map((w) => w.path)).toEqual([expect.stringMatching(/meta\.json$/)]);

    // Post-Wave-6 the leaf validates the AI's signals.json against the readiness contract,
    // then projects the agents-md-proposal body onto ctx. When the AI emits no proposal at
    // all (this test's fake response carries no parsed signals), the leaf surfaces an
    // InvalidStateError naming the missing projection.
    const err = failed?.error as { code?: string; message?: string } | undefined;
    expect(err?.code).toBe('invalid-state');
    expect(err?.message ?? '').toContain('no agents-md-proposal');
  });

  it('surfaces AI-proposed setup-skill and verify-skill bodies on the per-tool entry', async () => {
    // Audit-[09] readiness contract dropped the one-shell-line setup-script / verify-script
    // signals in favour of multi-paragraph setup-skill-proposal / verify-skill-proposal
    // bodies (markdown the harness lands as SKILL.md files). Verify both bodies survive the
    // contract round-trip and project onto the per-tool entry.
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: {
        readiness: [
          claudeMdProposal('# repo-a\n'),
          {
            type: 'setup-skill-proposal',
            content: '# Setup\n\nRun `pnpm install`.',
            timestamp: IsoTimestamp.now(),
          },
          {
            type: 'verify-skill-proposal',
            content: '# Verify\n\nRun `pnpm typecheck && pnpm lint && pnpm test`.',
            timestamp: IsoTimestamp.now(),
          },
        ],
      },
    });

    const interactive = scriptedInteractive({
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-scripts',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedSetupSkillBody).toContain('Run `pnpm install`');
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedVerifySkillBody).toContain(
      'pnpm typecheck && pnpm lint && pnpm test'
    );
  });

  it('leaves setup/verify proposals undefined when the AI omits the tags', async () => {
    const { project } = await buildScene();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      signals: { readiness: [claudeMdProposal('# repo-a\n')] },
    });

    const interactive = scriptedInteractive({
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai: claudeOnlySettings }
    );

    const runner = createRunner({
      id: 'r-readiness-no-scripts',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedSetupScript).toBeUndefined();
    expect(runner.ctx.entries['claude-code']?.proposal?.proposedVerifyScript).toBeUndefined();
  });
});
