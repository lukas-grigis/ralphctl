/**
 * `buildExecutionUnitLeaf` — materialise the per-task execution unit
 * folder under `<sprintDir>/execution/<unit-slug>/` and stamp the
 * resulting paths onto the chain context.
 *
 * The execution unit is the EVALUATOR'S cwd (or `--add-dir` mount,
 * for Claude). The generator session itself runs inside `task.projectPath`
 * — the unit folder only carries evaluator inputs (task.md, tasks plan,
 * project context, prior evaluations) plus the `evaluation.md` sink the
 * signal handler writes critiques to.
 *
 * Position in the chain: AFTER `mark-in-progress` and BEFORE the
 * evaluator round runs. The per-task chain wraps this leaf together
 * with `evaluate-task` in an `OnError(catchIf: code !== 'aborted',
 * fallback: noop)` so a unit-build failure (disk full, EPERM, …) does
 * NOT block task completion.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { SessionFolderBuilderPort } from '@src/business/ports/session-folder-builder-port.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

export interface BuildExecutionUnitCtx {
  readonly sprint?: Sprint;
  readonly tasks?: readonly Task[];
  readonly task?: Task;
  readonly executionUnitRoot?: AbsolutePath;
  readonly executionAddDirs?: readonly AbsolutePath[];
  readonly executionSessionCwd?: AbsolutePath;
}

export interface BuildExecutionUnitLeafDeps {
  readonly sessionFolderBuilder: SessionFolderBuilderPort;
  readonly aiSession: AiSessionPort;
}

export interface BuildExecutionUnitLeafOptions {
  readonly name?: string;
}

export function buildExecutionUnitLeaf<TCtx extends BuildExecutionUnitCtx>(
  deps: BuildExecutionUnitLeafDeps,
  opts: BuildExecutionUnitLeafOptions = {}
): Element<TCtx> {
  const name = opts.name ?? 'build-execution-unit';
  return new Leaf<
    TCtx,
    { readonly sprint: Sprint; readonly tasks: readonly Task[]; readonly task: Task },
    {
      readonly root: AbsolutePath;
      readonly addDirs: readonly AbsolutePath[];
      readonly sessionCwd: AbsolutePath;
    }
  >(name, {
    useCase: {
      async execute(input): Promise<
        Result<
          {
            readonly root: AbsolutePath;
            readonly addDirs: readonly AbsolutePath[];
            readonly sessionCwd: AbsolutePath;
          },
          DomainError
        >
      > {
        await deps.aiSession.ensureReady();
        const aiProvider = deps.aiSession.getProviderName();
        const priorEvaluations = collectPriorEvaluations(input.tasks);
        const built = await deps.sessionFolderBuilder.buildExecutionUnit({
          sprint: input.sprint,
          tasks: input.tasks,
          task: input.task,
          aiProvider,
          priorEvaluations,
        });
        if (!built.ok) return Result.error(built.error);
        return Result.ok(built.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`${name}: ctx.sprint must be loaded before this leaf`);
      }
      if (!ctx.tasks) {
        throw new Error(`${name}: ctx.tasks must be set before this leaf`);
      }
      if (!ctx.task) {
        throw new Error(`${name}: ctx.task must be set before this leaf`);
      }
      return { sprint: ctx.sprint, tasks: ctx.tasks, task: ctx.task };
    },
    output: (ctx, out) => ({
      ...ctx,
      executionUnitRoot: out.root,
      executionAddDirs: out.addDirs,
      executionSessionCwd: out.sessionCwd,
    }),
  });
}

function collectPriorEvaluations(tasks: readonly Task[]): ReadonlyMap<TaskId, string> {
  const map = new Map<TaskId, string>();
  for (const t of tasks) {
    if (t.evaluated && t.evaluationOutput !== undefined && t.evaluationOutput.length > 0) {
      map.set(t.id, t.evaluationOutput);
    }
  }
  return map;
}
