import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { withUpdate } from './sprint-repo-update.ts';

/** Single-sprint repo. `current()` is the last saved sprint; `saves` lists every `save` argument in order. */
export const inMemorySprintRepo = (
  initial: Sprint
): { readonly repo: SprintRepository; readonly current: () => Sprint; readonly saves: readonly Sprint[] } => {
  let current = initial;
  const saves: Sprint[] = [];
  const repo = withUpdate({
    async findById(id: SprintId) {
      if (current.id === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
    async save(sprint: Sprint) {
      current = sprint;
      saves.push(sprint);
      return Result.ok(undefined);
    },
    async list() {
      return Result.ok([current]);
    },
  }) as unknown as SprintRepository;
  return { repo, current: () => current, saves };
};

/** Read-only single-project repo (`findById` only). */
export const inMemoryProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

/** Single-execution repo keyed by `sprintId`; `saves` lists every `save` argument in order. */
export const inMemoryExecutionRepo = (
  initial: SprintExecution
): {
  readonly repo: SprintExecutionRepository;
  readonly current: () => SprintExecution;
  readonly saves: readonly SprintExecution[];
} => {
  let current = initial;
  const saves: SprintExecution[] = [];
  const repo: SprintExecutionRepository = {
    async findById(id: SprintId) {
      if (current.sprintId === id) return Result.ok(current);
      return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id) }));
    },
    async save(next: SprintExecution) {
      current = next;
      saves.push(next);
      return Result.ok(undefined);
    },
    async remove() {
      return Result.ok(undefined);
    },
  };
  return { repo, current: () => current, saves };
};

/** Task store ignoring the sprint id. `updates` / `saveAlls` record every `update` task / `saveAll` list in order. */
export const inMemoryTaskRepo = (
  initial: readonly Task[] = []
): {
  readonly repo: TaskRepository;
  readonly tasks: () => readonly Task[];
  readonly updates: readonly Task[];
  readonly saveAlls: ReadonlyArray<readonly Task[]>;
} => {
  let store: Task[] = [...initial];
  const updates: Task[] = [];
  const saveAlls: Array<readonly Task[]> = [];
  const repo: TaskRepository = {
    async findBySprintId() {
      return Result.ok<readonly Task[]>(store);
    },
    async findById(_sprintId: SprintId, taskId: TaskId) {
      const found = store.find((t) => t.id === taskId);
      if (found === undefined) return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
      return Result.ok(found);
    },
    async update(_sprintId: SprintId, task: Task) {
      const idx = store.findIndex((t) => t.id === task.id);
      if (idx >= 0) store[idx] = task;
      else store = [...store, task];
      updates.push(task);
      return Result.ok(undefined);
    },
    async saveAll(_sprintId: SprintId, tasks: readonly Task[]) {
      store = [...tasks];
      saveAlls.push(tasks);
      return Result.ok(undefined);
    },
  };
  return { repo, tasks: () => store, updates, saveAlls };
};
