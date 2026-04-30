import { describe, expect, it } from 'vitest';

import { Project } from '../../../domain/entities/project.ts';
import { Repository } from '../../../domain/entities/repository.ts';
import { Sprint } from '../../../domain/entities/sprint.ts';
import { Task } from '../../../domain/entities/task.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import type { TaskId } from '../../../domain/values/task-id.ts';
import { InMemoryProjectRepository } from '../../_test-fakes/in-memory-project-repository.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { InMemoryTaskRepository } from '../../_test-fakes/in-memory-task-repository.ts';
import { FakeExternalPort } from '../../_test-fakes/fake-external-port.ts';
import { ShowProgressUseCase, parseProgressTimeline } from './show-progress.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T18:00:00.000Z');

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok: ${String(r.error)}`);
  return r.value as T;
}

function buildSprint(): Sprint {
  return unwrap(
    Sprint.create({
      name: 'Sprint A',
      slug: unwrap(Slug.parse('sprint-a')),
      now: NOW,
    })
  );
}

function activate(s: Sprint): Sprint {
  return unwrap(s.activate(NOW));
}

function buildTask(
  name: string,
  opts?: {
    status?: 'todo' | 'in_progress' | 'done' | 'blocked';
    blockedBy?: readonly TaskId[];
    blockedReason?: string;
    order?: number;
  }
): Task {
  let task = unwrap(
    Task.create({
      name,
      steps: ['step-1'],
      verificationCriteria: ['vc-1'],
      order: opts?.order ?? 1,
      projectPath: AbsolutePath.trustString('/tmp/test-repo'),
      blockedBy: opts?.blockedBy,
    })
  );
  if (opts?.status === 'in_progress') {
    task = unwrap(task.markInProgress());
  } else if (opts?.status === 'done') {
    task = unwrap(task.markInProgress());
    task = unwrap(task.markDone());
  } else if (opts?.status === 'blocked') {
    task = unwrap(task.markBlocked(opts.blockedReason ?? 'reason'));
  }
  return task;
}

function makeUseCase(opts: {
  sprints: InMemorySprintRepository;
  tasks: InMemoryTaskRepository;
  projects?: InMemoryProjectRepository;
  external?: FakeExternalPort;
  progressFile?: string;
}): ShowProgressUseCase {
  return new ShowProgressUseCase(
    opts.sprints,
    opts.tasks,
    opts.projects ?? new InMemoryProjectRepository(),
    opts.external ?? new FakeExternalPort(),
    () => Promise.resolve(opts.progressFile ?? ''),
    () => '/fake/progress.md'
  );
}

describe('parseProgressTimeline', () => {
  it('returns an empty list for empty input', () => {
    expect(parseProgressTimeline('')).toEqual([]);
  });

  it('parses the new bullet format', () => {
    const md = '- 2026-04-29T17:00:00.000Z — Made progress on something';
    const out = parseProgressTimeline(md);
    expect(out).toHaveLength(1);
    expect(out[0]?.timestamp).toBe('2026-04-29T17:00:00.000Z');
    expect(out[0]?.line).toBe('Made progress on something');
  });

  it('parses the legacy bracket format', () => {
    const md = '[2026-04-29 17:00:00] Started working on task X';
    const out = parseProgressTimeline(md);
    expect(out).toHaveLength(1);
    expect(out[0]?.timestamp).toBe('2026-04-29 17:00:00');
    expect(out[0]?.line).toBe('Started working on task X');
  });

  it('tolerates malformed lines by surfacing the raw text', () => {
    const md = 'a random line with no timestamp\n# heading\n- valid 2026-04-29T10:00:00Z — body';
    const out = parseProgressTimeline(md);
    // Three non-empty lines: the random + heading + a partial bullet.
    // The bullet does NOT match because it lacks the strict shape; that's
    // by design — only `- <ts> — <text>` matches the new format.
    expect(out).toHaveLength(3);
    expect(out[0]?.line).toBe('a random line with no timestamp');
    expect(out[0]?.timestamp).toBe('');
  });

  it('handles a mix of formats', () => {
    const md = [
      '- 2026-04-29T17:00:00.000Z — first new entry',
      '[2026-04-29 16:00:00] legacy entry',
      '* 2026-04-29T15:00:00.000Z — bullet variant',
    ].join('\n');
    const out = parseProgressTimeline(md);
    expect(out).toHaveLength(3);
    expect(out[0]?.line).toBe('first new entry');
    expect(out[1]?.line).toBe('legacy entry');
    expect(out[2]?.line).toBe('bullet variant');
  });
});

describe('ShowProgressUseCase', () => {
  it('returns NotFoundError for missing sprint', async () => {
    const sprintRepo = new InMemorySprintRepository();
    const taskRepo = new InMemoryTaskRepository();
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const sprintId = unwrap(Sprint.create({ name: 'X', slug: unwrap(Slug.parse('x')), now: NOW })).id;
    const result = await uc.execute({ sprintId, now: NOW });
    expect(result.ok).toBe(false);
  });

  it('returns an empty report for a sprint with no tasks', async () => {
    const sprint = buildSprint();
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository();
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const result = await uc.execute({ sprintId: sprint.id, now: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tasks).toEqual([]);
    expect(result.value.timeline).toEqual([]);
    expect(result.value.blockers).toEqual([]);
    expect(result.value.staleTasks).toEqual([]);
    expect(result.value.dependencyCycle).toBeNull();
    expect(result.value.branchInconsistency).toEqual([]);
    expect(result.value.sprintStatus).toBe(sprint.status);
  });

  it('surfaces blocked tasks with reasons', async () => {
    const sprint = activate(buildSprint());
    const t1 = buildTask('Task one', { status: 'blocked', blockedReason: 'API down' });
    const t2 = buildTask('Task two', { status: 'todo', order: 2 });
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [t1, t2]]]);
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.task.name).toBe('Task one');
    expect(result.blockers[0]?.reason).toBe('API down');
  });

  it('reports sprintStatus = blocked when every remaining task is blocked', async () => {
    const sprint = activate(buildSprint());
    const t1 = buildTask('a', { status: 'blocked', blockedReason: 'r' });
    const t2 = buildTask('b', { status: 'done', order: 2 });
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [t1, t2]]]);
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.sprintStatus).toBe('blocked');
  });

  it('marks in_progress tasks with no signal as stale', async () => {
    const sprint = activate(buildSprint());
    const t1 = buildTask('Stuck task', { status: 'in_progress' });
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [t1]]]);
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.staleTasks).toHaveLength(1);
    expect(result.staleTasks[0]?.task.name).toBe('Stuck task');
  });

  it('does not flag in_progress tasks with a recent signal', async () => {
    const sprint = activate(buildSprint());
    const t1 = buildTask('Active task', { status: 'in_progress' });
    const recentSignal = `- 2026-04-29T17:55:00.000Z — Working on ${String(t1.id)}`;
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [t1]]]);
    const uc = makeUseCase({
      sprints: sprintRepo,
      tasks: taskRepo,
      progressFile: recentSignal,
    });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.staleTasks).toEqual([]);
  });

  it('flags in_progress tasks with old signals beyond the threshold', async () => {
    const sprint = activate(buildSprint());
    const t1 = buildTask('Stale task', { status: 'in_progress' });
    // 48h ago — well beyond the default 24h threshold.
    const oldSignal = `- 2026-04-27T17:00:00.000Z — touched ${String(t1.id)}`;
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [t1]]]);
    const uc = makeUseCase({
      sprints: sprintRepo,
      tasks: taskRepo,
      progressFile: oldSignal,
    });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.staleTasks).toHaveLength(1);
  });

  it('detects dependency cycles', async () => {
    const sprint = activate(buildSprint());
    const a = buildTask('a');
    const b = buildTask('b', { order: 2, blockedBy: [a.id] });
    // Build c referencing b in blockedBy, then mutate a to point at c via setBlockedBy.
    const c = buildTask('c', { order: 3, blockedBy: [b.id] });
    const aWithCycle = a.setBlockedBy([c.id]);
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [aWithCycle, b, c]]]);
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.dependencyCycle).not.toBeNull();
    expect((result.dependencyCycle ?? []).length).toBeGreaterThan(0);
  });

  it('reports a clean dependency graph when no cycle exists', async () => {
    const sprint = activate(buildSprint());
    const a = buildTask('a');
    const b = buildTask('b', { order: 2, blockedBy: [a.id] });
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [a, b]]]);
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.dependencyCycle).toBeNull();
  });

  it('detects branch inconsistency across project repos when sprint has a branch', async () => {
    const sprint = activate(buildSprint());
    const sprintWithBranch = unwrap(sprint.setBranch('ralphctl/sprint-a'));
    const repoPath = AbsolutePath.trustString('/tmp/test-repo');
    const repo = unwrap(Repository.create({ path: repoPath }));
    const project = unwrap(
      Project.create({
        name: unwrap(ProjectName.parse('demo')),
        displayName: 'Demo',
        repositories: [repo],
      })
    );
    const sprintRepo = new InMemorySprintRepository([sprintWithBranch]);
    const taskRepo = new InMemoryTaskRepository();
    const projects = new InMemoryProjectRepository([project]);
    const external = new FakeExternalPort({
      branchOk: false,
      currentBranch: 'main',
    });
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo, projects, external });

    const result = unwrap(await uc.execute({ sprintId: sprintWithBranch.id, now: NOW }));
    expect(result.branchInconsistency).toHaveLength(1);
    expect(result.branchInconsistency[0]?.expected).toBe('ralphctl/sprint-a');
    expect(result.branchInconsistency[0]?.actual).toBe('main');
  });

  it('skips branch checks when sprint has no branch', async () => {
    const sprint = activate(buildSprint());
    const repoPath = AbsolutePath.trustString('/tmp/test-repo');
    const repo = unwrap(Repository.create({ path: repoPath }));
    const project = unwrap(
      Project.create({
        name: unwrap(ProjectName.parse('demo')),
        displayName: 'Demo',
        repositories: [repo],
      })
    );
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository();
    const projects = new InMemoryProjectRepository([project]);
    const external = new FakeExternalPort({ branchOk: false });
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo, projects, external });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.branchInconsistency).toEqual([]);
  });

  it('parses progress timeline from progress.md', async () => {
    const sprint = activate(buildSprint());
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository();
    const md = ['- 2026-04-29T17:00:00.000Z — Started Task A', '- 2026-04-29T17:30:00.000Z — Completed Task A'].join(
      '\n'
    );
    const uc = makeUseCase({ sprints: sprintRepo, tasks: taskRepo, progressFile: md });

    const result = unwrap(await uc.execute({ sprintId: sprint.id, now: NOW }));
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[0]?.line).toBe('Started Task A');
  });
});
