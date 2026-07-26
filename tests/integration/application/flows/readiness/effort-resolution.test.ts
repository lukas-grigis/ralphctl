/**
 * Readiness's per-tool effort resolution must stay pinned to the shared
 * {@link clampEffortToProvider} clamp (`business/settings/resolve-effort.ts`) — a private local
 * table previously diverged from it (codex floored `xhigh`/`max` to `high` here, while the shared
 * clamp only floors `max` to `xhigh`).
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
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
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
import { clampEffortToProvider } from '@src/business/settings/resolve-effort.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-readiness-effort-cwd');

const fakeProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
    async save() {
      return Result.ok(undefined);
    },
  }) as unknown as ProjectRepository;

const absentProbes = (): ReadinessProbeRegistry =>
  ({
    codex: {
      tool: 'codex',
      async evaluate() {
        return Result.ok(absentState(FIXED_NOW));
      },
    } satisfies ReadinessProbe<ToolArtifacts>,
  }) as unknown as ReadinessProbeRegistry;

const scriptedInteractive = (confirms: readonly boolean[]): InteractivePrompt => {
  let idx = 0;
  return {
    async askText(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'not scripted' }));
    },
    async askTextArea(): Promise<Result<string, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'not scripted' }));
    },
    async askChoice<T>(): Promise<Result<T, DomainError>> {
      return Result.error(new ValidationError({ field: 'fake', value: null, message: 'not scripted' })) as Result<
        T,
        DomainError
      >;
    },
    async askConfirm(): Promise<Result<boolean, DomainError>> {
      const value = confirms[idx];
      idx += 1;
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

describe('readiness effort resolution mirrors the shared provider clamp', () => {
  let tmpDir: string;
  let repoPath: string;
  let runsRoot: AbsolutePath;

  beforeEach(async () => {
    const raw = await fs.mkdtemp('/tmp/ralphctl-readiness-effort-test-');
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

  it('a global codex `max` resolves to the shared clamp result (`xhigh`), not a stale local `high` floor', async () => {
    const repository = makeRepository({ path: repoPath, name: 'repo-a' });
    const project = makeProject({ repositories: [repository] });
    const eventBus = createInMemoryEventBus();
    const provider = createFakeAiProvider({
      signals: { readiness: [agentsMdProposal('# repo-a — generated by AI\n')] },
    });

    const codexRow = { provider: 'openai-codex', model: 'gpt-5.4' } as const;
    const ai: AiSettings = {
      refine: codexRow,
      plan: codexRow,
      implement: { generator: codexRow, evaluator: codexRow },
      readiness: codexRow,
      ideate: codexRow,
      createPr: codexRow,
      effort: 'max',
    };

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes: absentProbes(),
        providerFor: () => provider,
        skillsAdapterFor: () => noopSkillsAdapter,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive: scriptedInteractive([true]),
        writeFile: async () => Result.ok(undefined),
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillSource: emptySkillSource,
        runsRoot,
      },
      { projectId: project.id, cwd: FAKE_CWD, ai, providers: ['openai-codex'] }
    );

    const runner = createRunner({
      id: 'r-effort-clamp',
      element: flow,
      initialCtx: { projectId: project.id, tools: [], entries: {} },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(provider.recordedSessions).toHaveLength(1);
    // Pinned to the shared clamp so the two seams cannot silently diverge again.
    expect(provider.recordedSessions[0]?.effort).toBe(clampEffortToProvider('max', 'openai-codex'));
    expect(provider.recordedSessions[0]?.effort).toBe('xhigh');
  });
});
