import { join } from 'node:path';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * On-disk layout (rooted at `<root>`):
 *
 *   <root>/
 *     projects/
 *       <project-id>.json
 *     sprints/
 *       <sprint-id>/
 *         sprint.json
 *         execution.json
 *         tasks.json
 *
 * Projects are flat single-file JSON. Sprints get a per-sprint directory because a sprint
 * carries three sibling aggregates (the sprint itself, its execution, its task set) that the
 * domain treats as one unit of work — keeping them co-located makes "remove a sprint"
 * a single `rm -rf <sprint-dir>` regardless of which sub-files happened to exist.
 */

export const projectsDir = (root: AbsolutePath): string => join(String(root), 'projects');

export const projectFile = (root: AbsolutePath, id: ProjectId): string => join(projectsDir(root), `${String(id)}.json`);

export const sprintsDir = (root: AbsolutePath): string => join(String(root), 'sprints');

export const sprintDir = (root: AbsolutePath, id: SprintId): string => join(sprintsDir(root), String(id));

export const sprintFile = (root: AbsolutePath, id: SprintId): string => join(sprintDir(root, id), 'sprint.json');

export const executionFile = (root: AbsolutePath, id: SprintId): string => join(sprintDir(root, id), 'execution.json');

export const tasksFile = (root: AbsolutePath, id: SprintId): string => join(sprintDir(root, id), 'tasks.json');
