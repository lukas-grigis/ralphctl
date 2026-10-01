/**
 * Interrupted tasks — an `in_progress` task whose last attempt is still `running` while no implement run of this process
 * owns the sprint: the harness died (crash, SIGKILL, power loss) mid-attempt. Work's NEEDS YOU row and the task minimap
 * read the same predicate so they never disagree.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { budgetedAttemptCount } from '@src/domain/entity/task-attempts.ts';
import { readLastGeneratorRound } from '@src/application/flows/implement/leaves/round-artifacts.ts';
import { gitStatusPorcelain } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';

export interface InterruptedTask {
  readonly taskId: string;
  readonly name: string;
  /** The attempt that was running when the harness died, numbered the way the attempt budget counts it. */
  readonly attemptN: number;
  /** When that attempt started, epoch ms. */
  readonly startedAt: number;
}

/** What is cheap to learn about one interrupted task from disk; any field may be unknown. */
export interface InterruptedFacts {
  /** Uncommitted changes in the task's worktree (parallel) or repository checkout. */
  readonly uncommitted?: number;
  /** The attempt left a generator session the resume can pick up. */
  readonly resumable?: boolean;
  /** When the dead run last wrote its record, epoch ms — closer to the interruption than the attempt's start. */
  readonly since?: number;
}

/** `implementRunning`: a live implement run of this process already owns the sprint's in-progress tasks. */
export const interruptedTasksOf = (tasks: readonly Task[], implementRunning: boolean): readonly InterruptedTask[] => {
  if (implementRunning) return [];
  return tasks.flatMap((task): InterruptedTask[] => {
    const last = task.attempts.at(-1);
    if (task.status !== 'in_progress' || last === undefined || last.status !== 'running') return [];
    return [
      { taskId: task.id, name: task.name, attemptN: budgetedAttemptCount(task), startedAt: Date.parse(last.startedAt) },
    ];
  });
};

/** In-progress tasks whose last attempt was aborted (an operator stop) while no run of this process works them. */
export const stoppedTaskIds = (tasks: readonly Task[], implementRunning: boolean): ReadonlySet<string> =>
  implementRunning
    ? new Set()
    : new Set(
        tasks.filter((t) => t.status === 'in_progress' && t.attempts.at(-1)?.status === 'aborted').map((t) => t.id)
      );

export interface LoadInterruptedFactsDeps {
  readonly gitRunner: GitRunner;
  readonly dataRoot: AbsolutePath;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const loadOne = async (
  deps: LoadInterruptedFactsDeps,
  project: Project,
  sprint: Sprint,
  task: Task
): Promise<InterruptedFacts> => {
  const sprintPath = sprintDir(deps.dataRoot, sprint.id, sprint.slug);
  const worktree = join(sprintPath, 'worktrees', `wt-${task.id}`);
  const repo = project.repositories.find((r) => r.id === task.repositoryId);
  const treePath = (await exists(worktree)) ? AbsolutePath.parse(worktree) : undefined;
  const cwd = treePath?.ok === true ? treePath.value : repo?.path;
  const workspace = AbsolutePath.parse(join(sprintPath, 'implement', task.id));

  const [status, round] = await Promise.all([
    cwd !== undefined ? gitStatusPorcelain(deps.gitRunner, cwd) : undefined,
    workspace.ok ? readLastGeneratorRound(workspace.value) : undefined,
  ]);
  return {
    ...(status?.ok === true ? { uncommitted: status.value.length } : {}),
    resumable: round !== undefined,
  };
};

/** Best-effort probes, one per interrupted task; a probe that fails leaves its field unknown. */
export const loadInterruptedFacts = async (
  deps: LoadInterruptedFactsDeps,
  project: Project,
  sprint: Sprint,
  tasks: readonly Task[],
  interrupted: readonly InterruptedTask[]
): Promise<ReadonlyMap<string, InterruptedFacts>> => {
  const entries = await Promise.all(
    interrupted.flatMap((i) => {
      const task = tasks.find((t) => t.id === i.taskId);
      if (task === undefined) return [];
      return [loadOne(deps, project, sprint, task).then((facts) => [i.taskId, facts] as const)];
    })
  );
  return new Map(entries);
};
