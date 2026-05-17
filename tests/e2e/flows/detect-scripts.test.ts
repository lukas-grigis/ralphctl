import { describe, expect, it } from 'vitest';
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
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { absolutePath, makeProject, makeRepository, isoTimestamp } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { createDetectScriptsFlow } from '@src/application/flows/detect-scripts/flow.ts';
import { detectScriptsSession } from '@src/application/flows/detect-scripts/leaves/propose.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';

const DETECT_MARKER = '# Repository Script Detection Protocol';

/** Single-project repo with `findById` + a recording `save`. */
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
  readonly confirms?: readonly boolean[];
  readonly choices?: readonly unknown[];
  readonly texts?: readonly string[];
}

const scriptedInteractive = (answers: ScriptedAnswers): InteractivePrompt => {
  let confirmIdx = 0;
  let choiceIdx = 0;
  let textIdx = 0;
  return {
    async askText(): Promise<Result<string, DomainError>> {
      const v = answers.texts?.[textIdx];
      textIdx += 1;
      if (v === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted text' }));
      return Result.ok(v);
    },
    async askTextArea(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'askTextArea not scripted' }));
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      const v = answers.choices?.[choiceIdx];
      choiceIdx += 1;
      if (v === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted choice' }));
      return Result.ok(v as T) as Result<T, DomainError>;
    },
    async askConfirm(): Promise<Result<boolean, DomainError>> {
      const v = answers.confirms?.[confirmIdx];
      confirmIdx += 1;
      if (v === undefined)
        return Result.error(new ValidationError({ field: 'fake', value: null, message: 'no scripted confirm' }));
      return Result.ok(v);
    },
    async askMultiChoice<T>(): Promise<Result<readonly T[], DomainError>> {
      return Result.ok([]);
    },
  };
};

const buildDeps = (project: Project, providerResponse: string, interactive: InteractivePrompt) => {
  const { repo, saves } = fakeProjectRepo(project);
  const harness = createInMemorySink<HarnessSignal>();
  const eventBus = createInMemoryEventBus();
  const provider = createFakeAiProvider({
    responses: { 'detect-scripts': providerResponse },
    signals: {
      'detect-scripts': [{ type: 'note', text: 'sample', timestamp: IsoTimestamp.now() }],
    },
    markerOverrides: { 'detect-scripts': DETECT_MARKER },
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
      logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-11T10:00:00.000Z') }),
      interactive,
    },
  };
};

describe('createDetectScriptsFlow', () => {
  it('happy path — AI proposes both scripts, user accepts, project is saved with both fields', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/detect-scripts-repo', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['approve'] });
    const { deps, saves } = buildDeps(
      project,
      '<setup-script>pnpm install</setup-script>\n<verify-script>pnpm typecheck && pnpm lint && pnpm test</verify-script>',
      interactive
    );

    const flow = createDetectScriptsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-detect-1', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-project',
      'pick-repository',
      'propose',
      'confirm',
      'write',
    ]);

    expect(runner.ctx.proposal?.proposedSetupScript).toBe('pnpm install');
    expect(runner.ctx.proposal?.proposedVerifyScript).toBe('pnpm typecheck && pnpm lint && pnpm test');
    expect(runner.ctx.accepted).toBe(true);

    expect(saves).toHaveLength(1);
    const saved = saves[0]!.repositories[0]!;
    expect(saved.setupScript).toBe('pnpm install');
    expect(saved.checkScript).toBe('pnpm typecheck && pnpm lint && pnpm test');
  });

  it('rejection path — user declines → project is not saved', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/detect-scripts-repo-decline', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['reject'] });
    const { deps, saves } = buildDeps(
      project,
      '<setup-script>pnpm install</setup-script>\n<verify-script>pnpm test</verify-script>',
      interactive
    );

    const flow = createDetectScriptsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-detect-2', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.accepted).toBe(false);
    expect(saves).toHaveLength(0);
  });

  it('empty proposal + user skips — confirm asks, user declines, project untouched, chain still completes', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/detect-scripts-repo-empty', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['skip'] });
    const { deps, saves } = buildDeps(project, '<note>clean repo, nothing to wire</note>', interactive);

    const flow = createDetectScriptsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-detect-3', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.proposal?.proposedSetupScript).toBeUndefined();
    expect(runner.ctx.proposal?.proposedVerifyScript).toBeUndefined();
    expect(runner.ctx.accepted).toBe(false);
    expect(saves).toHaveLength(0);
  });

  it('empty proposal + user enters manually — confirm asks, user provides setup, save lands', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/detect-scripts-manual', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({
      choices: ['manual'],
      texts: ['pnpm install', ''],
    });
    const { deps, saves } = buildDeps(project, '<note>nothing detected</note>', interactive);

    const flow = createDetectScriptsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-detect-manual', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.accepted).toBe(true);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.repositories[0]!.setupScript).toBe('pnpm install');
    expect(saves[0]!.repositories[0]!.checkScript).toBeUndefined();
  });

  it('partial proposal — only setup-script proposed → save updates setupScript and leaves checkScript untouched', async () => {
    const existing = makeRepository({
      path: '/tmp/ralph/detect-scripts-partial',
      name: 'svc',
    });
    // Pre-seed a checkScript so we can verify it survives the update.
    const seeded = { ...existing, checkScript: 'pnpm test' } as typeof existing;
    const project = makeProject({ repositories: [seeded] });
    const interactive = scriptedInteractive({ choices: ['approve'] });
    const { deps, saves } = buildDeps(
      project,
      '<setup-script>pnpm install --frozen-lockfile</setup-script>',
      interactive
    );

    const flow = createDetectScriptsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-detect-4', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves).toHaveLength(1);
    const saved = saves[0]!.repositories[0]!;
    expect(saved.setupScript).toBe('pnpm install --frozen-lockfile');
    // The pre-seeded checkScript must be preserved — the verify-script tag was omitted.
    expect(saved.checkScript).toBe('pnpm test');
  });

  it('pre-selected repositoryId — single-repo project still works; pick-repository auto-resolves', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/detect-scripts-preselect', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({ choices: ['approve'] });
    const { deps, saves } = buildDeps(project, '<setup-script>pnpm install</setup-script>', interactive);

    const flow = createDetectScriptsFlow(deps, {
      projectId: project.id,
      repositoryId: repository.id,
      model: 'claude-sonnet-4-6',
    });
    const runner = createRunner({
      id: 'r-detect-5',
      element: flow,
      initialCtx: { projectId: project.id, repositoryId: repository.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(saves).toHaveLength(1);
    expect(saves[0]!.repositories[0]!.setupScript).toBe('pnpm install');
  });

  it('edit path — user tweaks proposed setup, drops verify, write applies only edited setup', async () => {
    const repository = makeRepository({ path: '/tmp/ralph/detect-scripts-edit', name: 'svc' });
    const project = makeProject({ repositories: [repository] });
    const interactive = scriptedInteractive({
      choices: ['edit'],
      // First askText edits the proposed setup; second askText returns empty → drop verify.
      texts: ['pnpm install --frozen-lockfile', ''],
    });
    const { deps, saves } = buildDeps(
      project,
      '<setup-script>pnpm install</setup-script>\n<verify-script>pnpm test</verify-script>',
      interactive
    );

    const flow = createDetectScriptsFlow(deps, { projectId: project.id, model: 'claude-sonnet-4-6' });
    const runner = createRunner({ id: 'r-detect-edit', element: flow, initialCtx: { projectId: project.id } });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.accepted).toBe(true);
    expect(runner.ctx.proposal?.proposedSetupScript).toBe('pnpm install --frozen-lockfile');
    expect(runner.ctx.proposal?.proposedVerifyScript).toBeUndefined();
    expect(saves).toHaveLength(1);
    const saved = saves[0]!.repositories[0]!;
    expect(saved.setupScript).toBe('pnpm install --frozen-lockfile');
    // Verify-script was dropped during editing — checkScript should not be touched.
    expect(saved.checkScript).toBeUndefined();
  });

  it('AiSession profile — runs read-only with the configured model', () => {
    const repository = makeRepository();
    const signalsFile = absolutePath('/tmp/signals.json');
    const session = detectScriptsSession(repository, '#prompt' as unknown as Prompt, 'claude-sonnet-4-6', signalsFile);
    expect(session.model).toBe('claude-sonnet-4-6');
    expect(session.permissions.canEditFiles).toBe(false);
    expect(session.permissions.canRunShell).toBe(false);
    expect(session.permissions.canAccessNetwork).toBe(true);
    expect(session.cwd).toBe(repository.path);
    expect(session.signalsFile).toBe(signalsFile);
  });
});
