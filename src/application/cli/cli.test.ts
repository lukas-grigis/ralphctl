/**
 * End-to-end CLI tests.
 *
 * Each test:
 *  1. Builds a fully wired `SharedDeps` against a temp `RALPHCTL_ROOT`.
 *  2. Captures stdout / stderr / exitCode through wrappers.
 *  3. Calls the command function directly (skipping Commander's parser
 *     for hot paths — Commander adds noise without exercising the actual
 *     command logic).
 *
 * For coverage of Commander wiring itself, the program-level test at the
 * bottom invokes `buildProgram(deps).parseAsync([...])` once with a
 * representative command.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { createSharedDeps, type SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { resolveStoragePaths, type StoragePaths } from '@src/application/runtime/storage-paths-resolver.ts';

import { runConfigSet } from './commands/config-set.ts';
import { runConfigShow } from './commands/config-show.ts';
import { runDoctorCommand } from './commands/doctor.ts';
import { runProjectAdd } from './commands/project-add.ts';
import { runProjectList } from './commands/project-list.ts';
import { runProjectRemove } from './commands/project-remove.ts';
import { runProjectShow } from './commands/project-show.ts';
import { runProjectOnboard } from './commands/project-onboard.ts';
import { runProjectRepoAdd } from './commands/project-repo-add.ts';
import { runProjectRepoRemove } from './commands/project-repo-remove.ts';
import { runSessionsList } from './commands/sessions-list.ts';
import { runSessionsKill } from './commands/sessions-kill.ts';
import { runSessionsDetach } from './commands/sessions-detach.ts';
import { runSprintClose } from './commands/sprint-close.ts';
import { runSprintCreate } from './commands/sprint-create.ts';
import { runSprintCreatePr } from './commands/sprint-create-pr.ts';
import { runSprintList } from './commands/sprint-list.ts';
import { runSprintRefine } from './commands/sprint-refine.ts';
import { runSprintRemove } from './commands/sprint-remove.ts';
import { runSprintShow } from './commands/sprint-show.ts';
import { runSprintStart } from './commands/sprint-start.ts';
import { runTaskAdd } from './commands/task-add.ts';
import { runTaskEditStatus } from './commands/task-edit-status.ts';
import { runTaskList } from './commands/task-list.ts';
import { runTaskRemove } from './commands/task-remove.ts';
import { runTaskShow } from './commands/task-show.ts';
import { runTicketAdd } from './commands/ticket-add.ts';
import { runTicketEdit } from './commands/ticket-edit.ts';
import { runTicketRemove } from './commands/ticket-remove.ts';
import { buildProgram } from './entrypoint.ts';
import { EXIT_ERROR, EXIT_NO_TASKS, EXIT_SUCCESS } from './exit-codes.ts';
import { FakeAiSessionPort } from '@src/business/_test-fakes/fake-ai-session-port.ts';
import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { Result as DomainResult } from '@src/domain/result.ts';

interface CapturedIo {
  readonly stdout: string;
  readonly stderr: string;
}

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-cli-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }, label: string): T {
  if (!r.ok) throw new Error(`${label}: ${String(r.error)}`);
  return r.value as T;
}

function slug(s: string) {
  return unwrap(Slug.parse(s), `slug(${s})`);
}

function asProjectName(s: string) {
  return unwrap(ProjectName.parse(s), `projectName(${s})`);
}

async function captureIo<T>(body: () => Promise<T>): Promise<{ result: T; io: CapturedIo }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  });
  try {
    const result = await body();
    return {
      result,
      io: { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') },
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function buildDeps(opts: {
  readonly storage: StoragePaths;
  readonly aiSession?: FakeAiSessionPort;
  readonly external?: FakeExternalPort;
}): Promise<SharedDeps> {
  return createSharedDeps({
    storage: opts.storage,
    logSink: 'plain-text',
    ...(opts.aiSession !== undefined ? { aiSession: opts.aiSession } : {}),
    ...(opts.external !== undefined ? { external: opts.external } : {}),
  });
}

describe('CLI commands', () => {
  let root: AbsolutePath;
  let storage: StoragePaths;
  let deps: SharedDeps;

  beforeEach(async () => {
    root = uniqueRoot();
    await mkdir(root, { recursive: true });
    storage = resolveStoragePaths({ root });
    deps = await buildDeps({ storage });
  });

  afterEach(async () => {
    await deps.sessionManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  // ── doctor ───────────────────────────────────────────────────────

  describe('doctor', () => {
    it('runs and reports a status', async () => {
      const { result, io } = await captureIo(() => runDoctorCommand(deps));
      expect([EXIT_SUCCESS, EXIT_ERROR]).toContain(result);
      expect(io.stdout).toContain('Doctor');
      expect(io.stdout).toMatch(/PASS|WARN|FAIL|SKIP/);
    });
  });

  // ── config ───────────────────────────────────────────────────────

  describe('config show', () => {
    it('prints defaults on a fresh install', async () => {
      const { result, io } = await captureIo(() => runConfigShow(deps));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('Configuration');
      expect(io.stdout).toContain('aiProvider');
      expect(io.stdout).toContain('evaluationIterations');
    });
  });

  describe('config set', () => {
    it('persists evaluationIterations', async () => {
      const { result } = await captureIo(() => runConfigSet(deps, 'evaluationIterations', '3'));
      expect(result).toBe(EXIT_SUCCESS);
      const loaded = await deps.configStore.load();
      expect(loaded.ok).toBe(true);
      if (loaded.ok) expect(loaded.value.evaluationIterations).toBe(3);
    });

    it('persists aiProvider', async () => {
      const { result } = await captureIo(() => runConfigSet(deps, 'aiProvider', 'copilot'));
      expect(result).toBe(EXIT_SUCCESS);
      const loaded = await deps.configStore.load();
      if (loaded.ok) expect(loaded.value.aiProvider).toBe('copilot');
    });

    it('rejects unknown keys', async () => {
      const { result, io } = await captureIo(() => runConfigSet(deps, 'bogus', 'x'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('error');
    });

    it('rejects invalid aiProvider value', async () => {
      const { result, io } = await captureIo(() => runConfigSet(deps, 'aiProvider', 'gpt'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('error');
    });

    it('rejects negative evaluationIterations', async () => {
      const { result } = await captureIo(() => runConfigSet(deps, 'evaluationIterations', '-1'));
      expect(result).toBe(EXIT_ERROR);
    });

    it('clears editor with empty string', async () => {
      const { result } = await captureIo(() => runConfigSet(deps, 'editor', ''));
      expect(result).toBe(EXIT_SUCCESS);
    });
  });

  // ── project ──────────────────────────────────────────────────────

  describe('project add / list / show / remove', () => {
    it('adds, lists, shows, and removes a project', async () => {
      const repoPath = '/tmp/test-repo-cli';

      const { result: addResult } = await captureIo(() =>
        runProjectAdd(deps, {
          name: 'demo',
          displayName: 'Demo',
          repoPath,
        })
      );
      expect(addResult).toBe(EXIT_SUCCESS);

      const { result: listResult, io: listIo } = await captureIo(() => runProjectList(deps));
      expect(listResult).toBe(EXIT_SUCCESS);
      expect(listIo.stdout).toContain('demo');

      const { result: showResult, io: showIo } = await captureIo(() => runProjectShow(deps, 'demo'));
      expect(showResult).toBe(EXIT_SUCCESS);
      expect(showIo.stdout).toContain('Demo');
      expect(showIo.stdout).toContain(repoPath);

      const { result: removeResult } = await captureIo(() => runProjectRemove(deps, 'demo'));
      expect(removeResult).toBe(EXIT_SUCCESS);
    });

    it('list prints empty hint when no projects', async () => {
      const { io } = await captureIo(() => runProjectList(deps));
      expect(io.stdout).toContain('No projects');
    });

    it('add fails on invalid name', async () => {
      const { result } = await captureIo(() =>
        runProjectAdd(deps, {
          name: 'NOT VALID',
          displayName: 'X',
          repoPath: '/tmp/x',
        })
      );
      expect(result).toBe(EXIT_ERROR);
    });

    it('add fails on relative repo path', async () => {
      const { result } = await captureIo(() =>
        runProjectAdd(deps, {
          name: 'demo',
          displayName: 'Demo',
          repoPath: 'relative/path',
        })
      );
      expect(result).toBe(EXIT_ERROR);
    });

    it('show fails on unknown project', async () => {
      const { result, io } = await captureIo(() => runProjectShow(deps, 'ghost'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('error');
    });

    it('repo-add appends a second repository', async () => {
      await captureIo(() =>
        runProjectAdd(deps, {
          name: 'demo',
          displayName: 'Demo',
          repoPath: '/tmp/repo-a',
        })
      );
      const { result } = await captureIo(() =>
        runProjectRepoAdd(deps, {
          project: 'demo',
          path: '/tmp/repo-b',
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
      const loaded = await deps.projectRepo.findByName(asProjectName('demo'));
      if (loaded.ok) expect(loaded.value.repositories.length).toBe(2);
    });

    it('repo-remove drops a repository when more than one exists', async () => {
      await captureIo(() =>
        runProjectAdd(deps, {
          name: 'demo',
          displayName: 'Demo',
          repoPath: '/tmp/repo-a',
        })
      );
      await captureIo(() =>
        runProjectRepoAdd(deps, {
          project: 'demo',
          path: '/tmp/repo-b',
        })
      );
      const { result } = await captureIo(() =>
        runProjectRepoRemove(deps, {
          project: 'demo',
          path: '/tmp/repo-b',
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
    });

    it('repo-remove refuses to drop the last repository', async () => {
      await captureIo(() =>
        runProjectAdd(deps, {
          name: 'demo',
          displayName: 'Demo',
          repoPath: '/tmp/repo-a',
        })
      );
      const { result } = await captureIo(() =>
        runProjectRepoRemove(deps, {
          project: 'demo',
          path: '/tmp/repo-a',
        })
      );
      expect(result).toBe(EXIT_ERROR);
    });

    it('onboard: drives the chain end-to-end with --auto and persists scripts + writes context file', async () => {
      // Use a real tmp repo dir so the onboard chain's writeContextFile leaf
      // can mkdir + writeFile on it.
      const repoDir = join(root, 'onboard-repo');
      await mkdir(repoDir, { recursive: true });

      const aiSession = new FakeAiSessionPort({
        outcomes: [{ kind: 'ok', result: { output: 'irrelevant — signals come from the parser fake' } }],
      });
      const customDeps = await buildDeps({ storage, aiSession });

      // Register the project with this repo path.
      await captureIo(() =>
        runProjectAdd(customDeps, {
          name: 'onboard-demo',
          displayName: 'Onboard Demo',
          repoPath: repoDir,
        })
      );

      // Wire the parser to surface all four onboarding signals.
      const onboardSignals: HarnessSignal[] = [
        {
          type: 'agents-md-proposal',
          content: '# Onboard Demo\n\nbody',
          timestamp: '2026-04-29T12:00:00.000Z' as ReturnType<typeof IsoTimestamp.trustString>,
        },
        {
          type: 'setup-script',
          command: 'pnpm install',
          timestamp: '2026-04-29T12:00:00.000Z' as ReturnType<typeof IsoTimestamp.trustString>,
        },
        {
          type: 'verify-script',
          command: 'pnpm test',
          timestamp: '2026-04-29T12:00:00.000Z' as ReturnType<typeof IsoTimestamp.trustString>,
        },
      ];
      // Spy on the real parser by overriding it via deps.
      const fakeParser: SignalParserPort = {
        parse: () => onboardSignals,
        parseWithDiagnostics: () => ({ signals: onboardSignals, diagnostics: [] }),
      };
      const onboardDeps = { ...customDeps, signalParser: fakeParser };

      const { result } = await captureIo(() => runProjectOnboard(onboardDeps, { project: 'onboard-demo', auto: true }));
      expect(result).toBe(EXIT_SUCCESS);

      // Check the context file was written.
      const written = await import('node:fs/promises').then((m) => m.readFile(join(repoDir, 'CLAUDE.md'), 'utf-8'));
      expect(written).toContain('# Onboard Demo');

      // Check the scripts were persisted.
      const project = await onboardDeps.projectRepo.findByName(asProjectName('onboard-demo'));
      expect(project.ok).toBe(true);
      if (project.ok) {
        const repo = project.value.repositories[0];
        expect(repo?.setupScript).toBe('pnpm install');
        expect(repo?.checkScript).toBe('pnpm test');
      }

      await onboardDeps.sessionManager.dispose();
    });

    it('onboard: fails with a clean error when project is unknown', async () => {
      const { result, io } = await captureIo(() => runProjectOnboard(deps, { project: 'ghost', auto: true }));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr.length + io.stdout.length).toBeGreaterThan(0);
    });
  });

  // ── sprint CRUD ──────────────────────────────────────────────────

  describe('sprint create / list / show / close / remove', () => {
    it('creates and lists a draft sprint', async () => {
      const { result } = await captureIo(() => runSprintCreate(deps, { name: 'A', slug: 'a', project: 'demo' }));
      expect(result).toBe(EXIT_SUCCESS);
      const { io: listIo } = await captureIo(() => runSprintList(deps));
      expect(listIo.stdout).toContain('draft');
    });

    it('show prints details for a known sprint', async () => {
      // Seed via the repo so we know the id.
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      const { result, io } = await captureIo(() => runSprintShow(deps, sprint.id));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain(sprint.id);
    });

    it('show fails on invalid id', async () => {
      const { result } = await captureIo(() => runSprintShow(deps, 'not-an-id'));
      expect(result).toBe(EXIT_ERROR);
    });

    it('close fails on a draft sprint', async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      const { result } = await captureIo(() => runSprintClose(deps, sprint.id));
      expect(result).toBe(EXIT_ERROR);
    });

    it('close succeeds on an active sprint', async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      const activated = unwrap(sprint.activate(IsoTimestamp.now()), 'activate');
      await deps.sprintRepo.save(activated);
      const { result } = await captureIo(() => runSprintClose(deps, activated.id));
      expect(result).toBe(EXIT_SUCCESS);
    });

    it('remove deletes the sprint', async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      const { result } = await captureIo(() => runSprintRemove(deps, sprint.id));
      expect(result).toBe(EXIT_SUCCESS);
      const lookup = await deps.sprintRepo.findById(sprint.id);
      expect(lookup.ok).toBe(false);
    });

    it('list prints empty hint when no sprints', async () => {
      const { io } = await captureIo(() => runSprintList(deps));
      expect(io.stdout).toContain('No sprints');
    });
  });

  // ── tickets ──────────────────────────────────────────────────────

  describe('ticket add / edit / remove', () => {
    let sprintId: ReturnType<typeof SprintId.trustString>;

    beforeEach(async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      sprintId = sprint.id;
    });

    it('adds a ticket to a draft sprint', async () => {
      const { result } = await captureIo(() =>
        runTicketAdd(deps, {
          sprint: sprintId,
          title: 'New ticket',
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
      const sprint = await deps.sprintRepo.findById(sprintId);
      if (sprint.ok) expect(sprint.value.tickets.length).toBe(1);
    });

    it('edit changes the title', async () => {
      const ticket = unwrap(Ticket.create({ title: 'Original' }), 'ticket');
      const sprint = await deps.sprintRepo.findById(sprintId);
      if (!sprint.ok) throw new Error('seed missing');
      const updated = unwrap(sprint.value.addTicket(ticket), 'add');
      await deps.sprintRepo.save(updated);

      const { result } = await captureIo(() =>
        runTicketEdit(deps, {
          sprint: sprintId,
          ticket: ticket.id,
          title: 'Edited',
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
      const after = await deps.sprintRepo.findById(sprintId);
      if (after.ok) {
        expect(after.value.ticketById(ticket.id)?.title).toBe('Edited');
      }
    });

    it('remove drops the ticket', async () => {
      const ticket = unwrap(Ticket.create({ title: 'Doomed' }), 'ticket');
      const sprint = await deps.sprintRepo.findById(sprintId);
      if (!sprint.ok) throw new Error('seed missing');
      const updated = unwrap(sprint.value.addTicket(ticket), 'add');
      await deps.sprintRepo.save(updated);

      const { result } = await captureIo(() => runTicketRemove(deps, { sprint: sprintId, ticket: ticket.id }));
      expect(result).toBe(EXIT_SUCCESS);
    });

    it('add fails on invalid sprint id', async () => {
      const { result } = await captureIo(() =>
        runTicketAdd(deps, {
          sprint: 'not-a-sprint',
          title: 't',
        })
      );
      expect(result).toBe(EXIT_ERROR);
    });
  });

  // ── tasks ────────────────────────────────────────────────────────

  describe('task add / list / show / edit-status / remove', () => {
    let sprintId: ReturnType<typeof SprintId.trustString>;

    beforeEach(async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      sprintId = sprint.id;
    });

    it('adds a task and lists it', async () => {
      const { result: addResult } = await captureIo(() =>
        runTaskAdd(deps, {
          sprint: sprintId,
          name: 'Build feature X',
          projectPath: '/tmp/repo-a',
          step: ['do thing'],
          criterion: ['it works'],
        })
      );
      expect(addResult).toBe(EXIT_SUCCESS);
      const { result: listResult, io: listIo } = await captureIo(() => runTaskList(deps, { sprint: sprintId }));
      expect(listResult).toBe(EXIT_SUCCESS);
      expect(listIo.stdout).toContain('Build feature X');
    });

    it('list prints empty placeholder', async () => {
      const { io } = await captureIo(() => runTaskList(deps, { sprint: sprintId }));
      expect(io.stdout).toContain('(no tasks)');
    });

    it('edit-status drives todo → in_progress', async () => {
      await captureIo(() =>
        runTaskAdd(deps, {
          sprint: sprintId,
          name: 'X',
          projectPath: '/tmp/repo-a',
        })
      );
      const tasks = await deps.taskRepo.findBySprintId(sprintId);
      const taskId = tasks.ok && tasks.value[0] ? tasks.value[0].id : TaskId.trustString('00000000');
      const { result } = await captureIo(() =>
        runTaskEditStatus(deps, {
          sprint: sprintId,
          task: taskId,
          action: 'mark-in-progress',
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
    });

    it('edit-status rejects unknown action', async () => {
      const { result } = await captureIo(() =>
        runTaskEditStatus(deps, {
          sprint: sprintId,
          task: '00000000',
          action: 'mark-blocked',
        })
      );
      expect(result).toBe(EXIT_ERROR);
    });

    it('show fails on missing task', async () => {
      const { result } = await captureIo(() => runTaskShow(deps, { sprint: sprintId, task: '00000000' }));
      expect(result).toBe(EXIT_ERROR);
    });

    it('remove fails on missing task', async () => {
      const { result } = await captureIo(() => runTaskRemove(deps, { sprint: sprintId, task: '00000000' }));
      expect(result).toBe(EXIT_ERROR);
    });
  });

  // ── workflow: sprint refine ──────────────────────────────────────

  describe('sprint refine', () => {
    it('exits early when no pending tickets', async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      const { result, io } = await captureIo(() => runSprintRefine(deps, { sprint: sprint.id }));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('No pending tickets');
    });

    it('fails on invalid sprint id', async () => {
      const { result } = await captureIo(() => runSprintRefine(deps, { sprint: 'not-a-sprint' }));
      expect(result).toBe(EXIT_ERROR);
    });

    it('fails on unknown sprint id (lookup fails)', async () => {
      const { result } = await captureIo(() =>
        runSprintRefine(deps, {
          sprint: '20260101-000000-missing',
        })
      );
      expect(result).toBe(EXIT_ERROR);
    });
  });

  // ── workflow: sprint start ───────────────────────────────────────

  describe('sprint start', () => {
    it('exits with EXIT_NO_TASKS when sprint has no tasks', async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      const { result, io } = await captureIo(() => runSprintStart(deps, { sprint: sprint.id, cwd: '/tmp' }));
      expect(result).toBe(EXIT_NO_TASKS);
      expect(io.stderr).toContain('no tasks');
    });

    it('fails on invalid sprint id', async () => {
      const { result } = await captureIo(() => runSprintStart(deps, { sprint: 'bad', cwd: '/tmp' }));
      expect(result).toBe(EXIT_ERROR);
    });
  });

  // ── workflow: sprint create-pr ───────────────────────────────────

  describe('sprint create-pr', () => {
    it('creates a PR via the chain and persists the URL on the sprint', async () => {
      const external = new FakeExternalPort({
        createPullRequestOutcomes: [DomainResult.ok({ url: 'https://github.com/o/r/pull/7' })],
      });
      const customDeps = await buildDeps({ storage, external });
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      const activated = unwrap(sprint.activate(IsoTimestamp.now()), 'activate');
      const branched = unwrap(activated.setBranch('ralphctl/test'), 'branch');
      await customDeps.sprintRepo.save(branched);

      const { result } = await captureIo(() =>
        runSprintCreatePr(customDeps, { sprint: sprint.id, base: 'main', cwd: '/tmp' })
      );
      expect(result).toBe(EXIT_SUCCESS);
      expect(external.createPullRequestCalls).toHaveLength(1);
      expect(external.createPullRequestCalls[0]?.branch).toBe('ralphctl/test');

      const reread = await customDeps.sprintRepo.findById(sprint.id);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.value.pullRequestUrl).toBe('https://github.com/o/r/pull/7');
    });

    it('fails when the sprint has no branch', async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      const { result, io } = await captureIo(() => runSprintCreatePr(deps, { sprint: sprint.id, cwd: '/tmp' }));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('no branch');
    });

    it('fails when no sprint id provided and no current sprint configured', async () => {
      const { result, io } = await captureIo(() => runSprintCreatePr(deps, { cwd: '/tmp' }));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('no sprint id');
    });
  });

  // ── sessions ─────────────────────────────────────────────────────

  describe('sessions', () => {
    it('list reports an empty list when nothing is running', async () => {
      const { result, io } = await captureIo(() => runSessionsList(deps));
      expect(result).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('No active sessions');
    });

    it('kill fails on unknown id', async () => {
      const { result, io } = await captureIo(() => runSessionsKill(deps, 'nope'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('error');
    });

    it('detach fails on unknown id', async () => {
      const { result } = await captureIo(() => runSessionsDetach(deps, 'nope'));
      expect(result).toBe(EXIT_ERROR);
    });
  });

  // ── task add edge cases ──────────────────────────────────────────

  describe('task add edge cases', () => {
    let sprintId: ReturnType<typeof SprintId.trustString>;

    beforeEach(async () => {
      const sprint = unwrap(
        Sprint.create({ name: 'A', slug: slug('a'), now: IsoTimestamp.now(), projectName: asProjectName('demo') }),
        'sprint'
      );
      await deps.sprintRepo.save(sprint);
      sprintId = sprint.id;
    });

    it('accepts --criterion repeated flag and stores all criteria in the task', async () => {
      // Legacy intent: src/integration/cli/cli-smoke.test.ts repeated-criterion capture
      const { result } = await captureIo(() =>
        runTaskAdd(deps, {
          sprint: sprintId,
          name: 'Multi-criterion task',
          projectPath: '/tmp/repo-a',
          step: ['step one'],
          criterion: ['crit A', 'crit B', 'crit C'],
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
      const tasks = await deps.taskRepo.findBySprintId(sprintId);
      expect(tasks.ok).toBe(true);
      if (tasks.ok) {
        const task = tasks.value[0];
        expect(task?.verificationCriteria).toStrictEqual(['crit A', 'crit B', 'crit C']);
      }
    });

    it('adds task with empty criteria list (no --criterion given)', async () => {
      // No --criterion is allowed; the use case stores an empty array.
      const { result } = await captureIo(() =>
        runTaskAdd(deps, {
          sprint: sprintId,
          name: 'No criteria task',
          projectPath: '/tmp/repo-a',
        })
      );
      expect(result).toBe(EXIT_SUCCESS);
      const tasks = await deps.taskRepo.findBySprintId(sprintId);
      expect(tasks.ok).toBe(true);
      if (tasks.ok) {
        expect(tasks.value[0]?.verificationCriteria).toStrictEqual([]);
      }
    });
  });

  // ── sprint create edge cases ─────────────────────────────────────

  describe('sprint create edge cases', () => {
    it('sprint create with a very long name (200+ chars) succeeds — Sprint.create does not cap name length', async () => {
      // Legacy intent: src/integration/cli/cli-smoke.test.ts long-name behavior.
      // Sprint.create trims whitespace but does NOT enforce a maximum name length.
      // Document: a 200-char name is accepted; callers wanting a cap must validate
      // before calling the command.
      const longName = 'A'.repeat(201);
      const { result } = await captureIo(() =>
        runSprintCreate(deps, { name: longName, slug: 'long-a', project: 'demo' })
      );
      expect(result).toBe(EXIT_SUCCESS);
    });
  });

  // ── doctor edge cases ─────────────────────────────────────────────

  describe('doctor with corrupt projects.json', () => {
    it('fails the project-paths check and exits EXIT_ERROR when projects.json is corrupt', async () => {
      // Legacy intent: src/integration/cli/cli-smoke.test.ts doctor-corrupt-projects
      // Write malformed JSON to projects.json so the project repo list() fails.
      const projectsFile = join(root, 'config', 'projects.json');
      await mkdir(join(root, 'config'), { recursive: true });
      await writeFile(projectsFile, '{ this is not json }', 'utf8');

      // Rebuild deps so the repo adapter picks up the corrupt file.
      const corruptStorage = resolveStoragePaths({ root });
      const corruptDeps = await buildDeps({ storage: corruptStorage });

      const { result, io } = await captureIo(() => runDoctorCommand(corruptDeps));
      await corruptDeps.sessionManager.dispose();

      expect(result).toBe(EXIT_ERROR);
      expect(io.stdout).toMatch(/FAIL/);
    });
  });

  // ── config set edge cases ─────────────────────────────────────────

  describe('config set edge cases', () => {
    it('rejects non-integer evaluationIterations with EXIT_ERROR', async () => {
      // Legacy intent: src/integration/cli/cli-smoke.test.ts config-set-invalid-value
      const { result, io } = await captureIo(() => runConfigSet(deps, 'evaluationIterations', 'abc'));
      expect(result).toBe(EXIT_ERROR);
      expect(io.stderr).toContain('error');
    });

    it('accepts evaluationIterations = 0 (disables evaluation)', async () => {
      const { result } = await captureIo(() => runConfigSet(deps, 'evaluationIterations', '0'));
      expect(result).toBe(EXIT_SUCCESS);
      const loaded = await deps.configStore.load();
      if (loaded.ok) expect(loaded.value.evaluationIterations).toBe(0);
    });
  });

  // ── program-level smoke ──────────────────────────────────────────

  describe('buildProgram', () => {
    it('builds a Commander program with all command groups attached', () => {
      const program = buildProgram(deps);
      const names = program.commands.map((c) => c.name());
      expect(names).toContain('doctor');
      expect(names).toContain('config');
      expect(names).toContain('project');
      expect(names).toContain('sprint');
      expect(names).toContain('ticket');
      expect(names).toContain('task');
      expect(names).toContain('sessions');
    });
  });
});
