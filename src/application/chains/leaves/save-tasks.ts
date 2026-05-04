/**
 * `saveTasksLeaf` — reusable Leaf factory that atomically replaces the
 * full task list for a sprint via {@link TaskRepository.saveAll} and
 * writes the companion `done-criteria.md` artefact.
 *
 * `done-criteria.md` is a stable, on-disk reference — one bullet per
 * task naming its success criterion. The evaluator reads it from the
 * per-task execution unit folder so it has an explicit, persistent
 * definition of "done" rather than re-deriving it from the prompt each
 * round. See Anthropic "Effective Harnesses for Long-Running Agents".
 *
 * Used by `plan` (initial + replan) and `ideate` (combined ticket + tasks
 * write). The replace-all primitive is the only safe write for replan:
 * partial updates would leave the file mid-mutation visible to a crashing
 * harness.
 */
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

import type { Task } from '@src/domain/entities/task.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { StorageError as StorageErrorImpl } from '@src/domain/errors/storage-error.ts';
import type { TaskRepository } from '@src/domain/repositories/task-repository.ts';
import { Result } from '@src/domain/result.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';

export interface SaveTasksCtx {
  readonly sprintId: SprintId;
  readonly tasks?: readonly Task[];
}

export interface SaveTasksLeafDeps {
  readonly taskRepo: TaskRepository;
}

// ─────────────────────── done-criteria renderer ────────────────────────

const FALLBACK_CRITERION = '(no explicit criteria — use task description as proxy)';

/**
 * Render the sprint-level `done-criteria.md` artefact. One bullet per
 * task in input order (post-topo-reorder is fine — the file is
 * documentation, not execution ordering).
 *
 * When a task has no `verificationCriteria`, the bullet emits the
 * {@link FALLBACK_CRITERION} sentinel so the evaluator knows the absence
 * is intentional rather than a missing file.
 */
export function renderDoneCriteria(tasks: readonly Task[]): string {
  const lines: string[] = [
    '# Done criteria',
    '',
    'Each bullet states what "done" means for the corresponding task.',
    'The evaluator reads this file as a stable reference for grading.',
    '',
  ];
  for (const task of tasks) {
    const criteria = task.verificationCriteria.length > 0 ? task.verificationCriteria.join('; ') : FALLBACK_CRITERION;
    lines.push(`- **${task.name}** (\`${String(task.id)}\`) — ${criteria}`);
  }
  // Ensure trailing newline.
  return lines.join('\n') + '\n';
}

// ─────────────────────── leaf factory ────────────────────────────────

export function saveTasksLeaf<TCtx extends SaveTasksCtx>(deps: SaveTasksLeafDeps, name = 'save-tasks'): Element<TCtx> {
  return new Leaf<TCtx, { readonly sprintId: SprintId; readonly tasks: readonly Task[] }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, StorageError>> {
        // 1. Persist tasks.json via the repository.
        const saved = await deps.taskRepo.saveAll(input.sprintId, input.tasks);
        if (!saved.ok) return Result.error(saved.error);

        // 2. Write done-criteria.md alongside tasks.json in the sprint dir.
        const storage = resolveStoragePaths();
        const criteriaPath = String(storage.doneCriteriaFile(input.sprintId));
        try {
          await mkdir(dirname(criteriaPath), { recursive: true });
          const body = renderDoneCriteria(input.tasks);
          await writeFile(criteriaPath, body, { encoding: 'utf-8', mode: 0o600 });
        } catch (err) {
          return Result.error(
            new StorageErrorImpl({
              subCode: 'io',
              message: `save-tasks: failed to write done-criteria.md: ${err instanceof Error ? err.message : String(err)}`,
              path: criteriaPath,
              cause: err,
            })
          );
        }

        return Result.ok();
      },
    },
    input: (ctx) => {
      if (!ctx.tasks) {
        throw new Error(`Leaf '${name}' requires ctx.tasks to be set`);
      }
      return { sprintId: ctx.sprintId, tasks: ctx.tasks };
    },
    output: (ctx) => ctx,
  });
}
