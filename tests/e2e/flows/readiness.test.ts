import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
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
import { absolutePath, FIXED_NOW, isoTimestamp, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { createInMemorySink } from '@tests/fixtures/in-memory-sink.ts';
import { createFsTemplateLoader, defaultTemplatesDir } from '@src/integration/ai/prompts/_engine/fs-template-loader.ts';
import { createFakeAiProvider } from '@tests/fixtures/fake-ai-provider.ts';
import { createReadinessFlow } from '@src/application/flows/readiness/flow.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { emptySkillSource, noopSkillsAdapter } from '@tests/fixtures/skills-fakes.ts';
import { readinessSession } from '@src/application/flows/readiness/leaves/propose.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';

const FAKE_CWD = absolutePath('/tmp/ralph/fake-readiness-cwd');

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

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp('/tmp/ralphctl-readiness-test-');
    repoPath = join(tmpDir, 'repo-a');
    await fs.mkdir(repoPath, { recursive: true });
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
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const capturedLogs: Array<{ level: string; message: string }> = [];
    eventBus.subscribe((e) => {
      if (e.type === 'log') capturedLogs.push({ level: e.level, message: e.message });
    });
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      responses: {
        readiness: '<claude-md>\n# repo-a\n\n## Build & Run\n- pnpm install\n</claude-md>',
      },
      signals: {
        readiness: [{ type: 'note', text: 'small repo', timestamp: IsoTimestamp.now() }],
      },
    });

    const interactive = scriptedInteractive({
      // pick-tool is the only choice asked (single-repo project skips pick-repository).
      choices: ['claude-code' as AssistantTool],
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-1',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    expect(runner.trace.map((e) => e.elementName)).toEqual([
      'load-project',
      'pick-repository',
      'pick-tool',
      'probe',
      'install-skills',
      'propose',
      'uninstall-skills',
      'confirm',
      'write',
    ]);

    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.path).toBe(join(String(repository.path), 'CLAUDE.md'));
    expect(writer.writes[0]?.content).toContain('# repo-a');
    expect(writer.writes[0]?.content).toContain('## Build & Run');

    // `<claude-md>` parses into an agents-md-proposal signal; the harness sink sees both.
    expect(harness.entries.map((s) => s.type)).toEqual(['agents-md-proposal', 'note']);

    expect(runner.ctx.accepted).toBe(true);
    expect(runner.ctx.proposal?.proposedContent).toContain('# repo-a');

    const messages = capturedLogs.map((e) => e.message);
    expect(messages.some((m) => m.includes('starting repo'))).toBe(true);
    expect(messages.some((m) => m.includes('proposal ready'))).toBe(true);
    expect(messages.some((m) => m.includes('wrote'))).toBe(true);
  });

  it('AiSession profile — readiness runs read-only with the configured model (no edit, no shell, no auto-approve)', () => {
    const session = readinessSession(
      FAKE_CWD,
      '#prompt' as unknown as Prompt,
      'claude-sonnet-4-6',
      absolutePath('/tmp/signals.json')
    );
    expect(session.model).toBe('claude-sonnet-4-6');
    expect(session.permissions.canEditFiles).toBe(false);
    expect(session.permissions.canRunShell).toBe(false);
    expect(session.permissions.autoApprove).toBe(false);
  });

  it('rejection path — user declines → no file is written', async () => {
    const { project } = await buildScene();
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const capturedLogs: Array<{ level: string; message: string }> = [];
    eventBus.subscribe((e) => {
      if (e.type === 'log') capturedLogs.push({ level: e.level, message: e.message });
    });
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      responses: { readiness: '<claude-md>\n# repo-a\n</claude-md>' },
    });

    const interactive = scriptedInteractive({
      choices: ['claude-code' as AssistantTool],
      confirms: [false], // user declines
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => isoTimestamp('2026-05-09T10:00:00.000Z'),
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-2',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.accepted).toBe(false);
    expect(writer.writes).toHaveLength(0);

    const messages = capturedLogs.map((e) => e.message);
    expect(messages.some((m) => m.includes('skipping write'))).toBe(true);
  });

  it('backup path — existing file → writes <target>.bak.<timestamp> before overwriting', async () => {
    const { project, repository } = await buildScene({ existingFile: '# old content\n' });
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      responses: { readiness: '<claude-md>\n# new content\n</claude-md>' },
    });

    const interactive = scriptedInteractive({
      choices: ['claude-code' as AssistantTool],
      confirms: [true],
    });

    // Pin the clock so the backup-suffix is fully deterministic.
    const PINNED = isoTimestamp('2026-05-09T10:00:00.000Z');
    const expectedSuffix = String(PINNED).replace(/:/g, '-');

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => PINNED,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-3',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');

    const targetPath = join(String(repository.path), 'CLAUDE.md');
    const backupPath = `${targetPath}.bak.${expectedSuffix}`;

    // Backup precedes the new write; both paths recorded.
    expect(writer.writes.map((w) => w.path)).toEqual([backupPath, targetPath]);
    expect(writer.writes[0]?.content).toBe('# old content\n');
    expect(writer.writes[1]?.content).toContain('# new content');
  });

  it('surfaces a typed error when probe registry has no matching probe but the chain still completes (unknown state)', async () => {
    // Empty probe registry → evaluateReadiness returns `unknownState`. Chain still flows
    // and the AI is asked to propose a fresh body.
    const { project } = await buildScene();
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      responses: { readiness: '<claude-md>\n# fresh\n</claude-md>' },
    });

    const interactive = scriptedInteractive({
      choices: ['claude-code' as AssistantTool],
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes: {}, // no probes registered
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-4',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.probedState?.kind).toBe('unknown');
    expect(writer.writes).toHaveLength(1);
  });

  it('surfaces a ParseError when the AI omits the <claude-md> tag', async () => {
    const { project } = await buildScene();
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      // No <claude-md> in the body — the use case must surface a ParseError.
      responses: { readiness: 'no agents-md here, just commentary' },
    });

    const interactive = scriptedInteractive({
      choices: ['claude-code' as AssistantTool],
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-5',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('failed');
    const failed = runner.trace.find((e) => e.status === 'failed');
    expect(failed?.elementName).toBe('propose');
    expect(writer.writes).toHaveLength(0);
  });

  it('surfaces AI-proposed setup-script and verify-script on ctx.proposal', async () => {
    const { project } = await buildScene();
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      responses: {
        readiness: [
          '<claude-md>',
          '# repo-a',
          '',
          '## Build & Run',
          '- pnpm install',
          '</claude-md>',
          '<setup-script>pnpm install</setup-script>',
          '<verify-script>pnpm typecheck && pnpm lint && pnpm test</verify-script>',
        ].join('\n'),
      },
    });

    const interactive = scriptedInteractive({
      choices: ['claude-code' as AssistantTool],
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-scripts',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.proposal?.proposedSetupScript).toBe('pnpm install');
    expect(runner.ctx.proposal?.proposedVerifyScript).toBe('pnpm typecheck && pnpm lint && pnpm test');
  });

  it('leaves setup/verify proposals undefined when the AI omits the tags', async () => {
    const { project } = await buildScene();
    const harness = createInMemorySink<HarnessSignal>();
    const eventBus = createInMemoryEventBus();
    const probes = fakeProbeRegistry('claude-code', absentState(FIXED_NOW));
    const writer = recordingWriteFile();

    const provider = createFakeAiProvider({
      responses: { readiness: '<claude-md>\n# repo-a\n</claude-md>' },
    });

    const interactive = scriptedInteractive({
      choices: ['claude-code' as AssistantTool],
      confirms: [true],
    });

    const flow = createReadinessFlow(
      {
        projectRepo: fakeProjectRepo(project),
        probes,
        provider,
        templateLoader: createFsTemplateLoader(defaultTemplatesDir()),
        signals: harness,
        eventBus,
        logger: createEventBusLogger({ eventBus, clock: () => isoTimestamp('2026-05-09T10:00:00.000Z') }),
        interactive,
        writeFile: writer.write,
        clock: () => FIXED_NOW,
        skillsAdapter: noopSkillsAdapter,
        skillSource: emptySkillSource,
      },
      { projectId: project.id, cwd: FAKE_CWD, model: 'claude-sonnet-4-6' }
    );

    const runner = createRunner({
      id: 'r-readiness-no-scripts',
      element: flow,
      initialCtx: { projectId: project.id },
    });
    await runner.start();

    expect(runner.status).toBe('completed');
    expect(runner.ctx.proposal?.proposedSetupScript).toBeUndefined();
    expect(runner.ctx.proposal?.proposedVerifyScript).toBeUndefined();
  });
});
