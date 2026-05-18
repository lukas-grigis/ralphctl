import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { absolutePath, makeProject, makeRepository, isoTimestamp } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createDetectSkillsFlow } from '@src/application/flows/detect-skills/flow.ts';
import { detectSkillsSession } from '@src/application/flows/detect-skills/leaves/propose.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';

const DETECT_SKILLS_MARKER = '# Per-Repository Skill Authoring Protocol';

const fakeProjectRepo = (project: Project): { repo: ProjectRepository; saves: Project[] } => {
  const saves: Project[] = [];
  let current = project;
  const repo = {
    async findById(id: ProjectId) {
      if (current.id === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
    async save(next: Project) {
      saves.push(next);
      current = next;
      return Result.ok(undefined);
    },
  } as unknown as ProjectRepository;
  return { repo, saves };
};

interface ScriptedAnswers {
  readonly choices?: readonly unknown[];
}

const scriptedInteractive = (answers: ScriptedAnswers): InteractivePrompt => {
  let choiceIdx = 0;
  return {
    async askText(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted text' }));
    },
    async askTextArea(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted textarea' }));
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      const v = answers.choices?.[choiceIdx];
      choiceIdx += 1;
      if (v === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted choice' }));
      return Result.ok(v as T) as Result<T, DomainError>;
    },
    async askConfirm(): Promise<Result<boolean, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted confirm' }));
    },
    async askMultiChoice<T>(): Promise<Result<readonly T[], DomainError>> {
      return Result.ok([]);
    },
  };
};

const buildDeps = (
  project: Project,
  providerResponse: string,
  interactive: InteractivePrompt,
  runsRoot: AbsolutePath
) => {
  const { repo, saves } = fakeProjectRepo(project);
  const harness = createInMemorySink<HarnessSignal>();
  const eventBus = createInMemoryEventBus();
  const provider = createFakeAiProvider({
    responses: { 'detect-skills': providerResponse },
    signals: {
      'detect-skills': [{ type: 'note', text: 'sample', timestamp: IsoTimestamp.now() }],
    },
    markerOverrides: { 'detect-skills': DETECT_SKILLS_MARKER },
  });
  return {
    repo,
    saves,
    harness,
    eventBus,
    deps: {
      projectRepo: repo,
      provider,
      templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
      signals: harness,
      eventBus,
      logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-12T11:00:00.000Z') }),
      interactive,
      skillsAdapter: noopSkillsAdapter,
      runsRoot,
    },
  };
};

const SETUP_BODY = `Use pnpm@9 (pinned via mise.toml). Run \`pnpm install\` at the repo root —
the workspace pulls in every sub-package's deps.`;
const VERIFY_BODY = `Run \`pnpm typecheck && pnpm lint && pnpm test\`. Typecheck errors surface
in TS' standard form; lint errors flag ESLint rules; tests use vitest with concise diffs.`;

describe('createDetectSkillsFlow', () => {
  // Per-test tmp `runsRoot` so propose's persistent artifacts (prompt.md, body.txt) land
  // somewhere disposable. Production lifecycle is user-managed.
  let runsRoot: AbsolutePath;
  let runsRootRaw: string;

  beforeEach(async () => {
    const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-detect-skills-runs-'));
    runsRootRaw = await realpath(raw);
    const parsed = AbsolutePath.parse(runsRootRaw);
    if (!parsed.ok) throw new Error('AbsolutePath.parse failed');
    runsRoot = parsed.value;
  });

  afterEach(async () => {
    await fs.rm(runsRootRaw, { recursive: true, force: true });
  });

  it('happy path — AI proposes both skills, user approves, project is saved with both fields', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/skills-repo', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['approve'] });
    const { deps, saves } = buildDeps(
      project,
      `<setup-skill>\n${SETUP_BODY}\n</setup-skill>\n<verify-skill>\n${VERIFY_BODY}\n</verify-skill>`,
      interactive,
      runsRoot
    );

    const flow = createDetectSkillsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-skills-1', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-project',
      'pick-repository',
      'propose',
      'confirm',
      'write',
    ]);

    expect(runner.ctx.proposal?.proposedSetupSkill).toBe(SETUP_BODY);
    expect(runner.ctx.proposal?.proposedVerifySkill).toBe(VERIFY_BODY);
    expect(runner.ctx.accepted).toBe(true);

    expect(saves).toHaveLength(1);
    const saved = saves[0]!.repositories[0]!;
    expect(saved.setupSkill).toBe(SETUP_BODY);
    expect(saved.verifySkill).toBe(VERIFY_BODY);
  });

  it('rejection path — user declines → project is not saved', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/skills-decline', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['reject'] });
    const { deps, saves } = buildDeps(project, `<setup-skill>${SETUP_BODY}</setup-skill>`, interactive, runsRoot);

    const flow = createDetectSkillsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-skills-2', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.accepted).toBe(false);
    expect(saves).toHaveLength(0);
  });

  it('empty proposal — confirm surfaces the AI body and asks user to skip; project untouched', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/skills-empty', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    // Empty proposal now surfaces the AI's response and asks the user to acknowledge ("skip").
    const interactive = scriptedInteractive({ choices: ['skip'] });
    const { deps, saves } = buildDeps(
      project,
      '<note>generic project, no per-repo guidance needed</note>',
      interactive,
      runsRoot
    );

    const flow = createDetectSkillsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-skills-3', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.proposal?.proposedSetupSkill).toBeUndefined();
    expect(runner.ctx.proposal?.proposedVerifySkill).toBeUndefined();
    expect(runner.ctx.accepted).toBe(false);
    expect(saves).toHaveLength(0);
  });

  it('failsafe — empty proposal surfaces the raw AI body inline in the confirm prompt', async () => {
    const permissionAskBody = 'I need read permission for /repo. Approve the prompt in the UI and I will continue.';
    const repository = makeRepository({ path: '/tmp/ralph/skills-failsafe', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const recordedChoicePrompts: string[] = [];
    const recordingInteractive: InteractivePrompt = {
      ...scriptedInteractive({ choices: ['skip'] }),
      async askChoice<T>(question: string): Promise<Result<T, DomainError>> {
        recordedChoicePrompts.push(question);
        return Result.ok('skip' as unknown as T) as Result<T, DomainError>;
      },
    };
    const { deps } = buildDeps(project, permissionAskBody, recordingInteractive, runsRoot);

    const flow = createDetectSkillsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-skills-failsafe', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    const emptyProposalPrompt = recordedChoicePrompts.find((p) => p.includes('AI returned no skill proposals'));
    expect(emptyProposalPrompt).toBeDefined();
    expect(emptyProposalPrompt!).toContain('AI response:');
    expect(emptyProposalPrompt!).toContain('I need read permission');
  });

  it('partial proposal — only verify-skill proposed → save updates verifySkill, leaves setupSkill untouched', async () => {
    const existing = makeRepository({ path: '/tmp/ralph/skills-partial', name: 'svc' });
    const seeded = { ...existing, setupSkill: 'pre-existing setup body' } as typeof existing;
    const project = makeProject({ repositories: [seeded] });
    const interactive = scriptedInteractive({ choices: ['approve'] });
    const { deps, saves } = buildDeps(project, `<verify-skill>${VERIFY_BODY}</verify-skill>`, interactive, runsRoot);

    const flow = createDetectSkillsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-skills-4', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves).toHaveLength(1);
    const saved = saves[0]!.repositories[0]!;
    expect(saved.verifySkill).toBe(VERIFY_BODY);
    // Pre-existing setup body must survive — verify-only proposals do not clobber.
    expect(saved.setupSkill).toBe('pre-existing setup body');
  });

  it('pre-selected repositoryId — single-repo project still works; pick-repository auto-resolves', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/skills-preselect', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['approve'] });
    const { deps, saves } = buildDeps(project, `<setup-skill>${SETUP_BODY}</setup-skill>`, interactive, runsRoot);

    const flow = createDetectSkillsFlow(deps, {
      projectId: project.id,
      repositoryId: repository.id,
      model: 'claude-sonnet-4-6',
    });
    const runner = createRunner({
      id: 'r-skills-5',
      element: flow,
      initialCtx: { projectId: project.id, repositoryId: repository.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.repositories[0]!.setupSkill).toBe(SETUP_BODY);
  });

  it('AiSession profile — runs read-only with the configured model', () => {
    const repository = makeRepository();
    const signalsFile = absolutePath('/tmp/signals.json');
    const session = detectSkillsSession(repository, '#prompt' as unknown as Prompt, 'claude-sonnet-4-6', signalsFile);
    expect(session.model).toBe('claude-sonnet-4-6');
    expect(session.permissions.canEditFiles).toBe(false);
    expect(session.permissions.canRunShell).toBe(false);
    expect(session.permissions.canAccessNetwork).toBe(true);
    expect(session.cwd).toBe(repository.path);
    expect(session.signalsFile).toBe(signalsFile);
  });
});
