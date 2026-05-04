/**
 * `buildPlanningFolderLeaf` — materialise the per-sprint planning folder
 * under `<sprintDir>/planning/` and stamp the resulting paths onto the
 * chain context.
 *
 * The planning folder IS the AI session's cwd. The AI is told to write
 * its raw `tasks.json` to `./tasks.json`; the chain's `save-tasks` leaf
 * then promotes that file to the canonical `<sprintDir>/tasks.json`.
 *
 * Affected repos are exposed via `--add-dir <repo>` (Claude) or, for
 * Copilot only, via the read-only mirror inside `<root>/repos/<basename>/`
 * that the adapter builds — Copilot has no `--add-dir` equivalent.
 */
import { Result } from '@src/domain/result.ts';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { SessionFolderBuilderPort } from '@src/business/ports/session-folder-builder-port.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import type { Element } from '@src/kernel/chain/element.ts';

export interface BuildPlanningFolderCtx {
  readonly sprint?: Sprint;
  readonly tasks?: readonly Task[];
  readonly cwd?: AbsolutePath;
  readonly planningFolderRoot?: AbsolutePath;
  readonly planningSessionMdPath?: AbsolutePath;
  readonly planningRawTasksJsonPath?: AbsolutePath;
  readonly planAddDirs?: readonly AbsolutePath[];
}

export interface BuildPlanningFolderLeafDeps {
  readonly sessionFolderBuilder: SessionFolderBuilderPort;
  readonly aiSession: AiSessionPort;
}

export interface BuildPlanningFolderLeafOptions {
  readonly name?: string;
}

export function buildPlanningFolderLeaf<TCtx extends BuildPlanningFolderCtx>(
  deps: BuildPlanningFolderLeafDeps,
  opts: BuildPlanningFolderLeafOptions = {}
): Element<TCtx> {
  const name = opts.name ?? 'build-planning-folder';
  return new Leaf<
    TCtx,
    { readonly sprint: Sprint },
    {
      readonly root: AbsolutePath;
      readonly sessionMdPath: AbsolutePath;
      readonly rawTasksJsonPath: AbsolutePath;
      readonly addDirs: readonly AbsolutePath[];
    }
  >(name, {
    useCase: {
      async execute(input): Promise<
        Result<
          {
            readonly root: AbsolutePath;
            readonly sessionMdPath: AbsolutePath;
            readonly rawTasksJsonPath: AbsolutePath;
            readonly addDirs: readonly AbsolutePath[];
          },
          DomainError
        >
      > {
        await deps.aiSession.ensureReady();
        const aiProvider = deps.aiSession.getProviderName();
        const built = await deps.sessionFolderBuilder.buildPlanningFolder({
          sprint: input.sprint,
          aiProvider,
        });
        if (!built.ok) return Result.error(built.error);
        return Result.ok(built.value);
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) {
        throw new Error(`${name}: ctx.sprint must be loaded before this leaf`);
      }
      return { sprint: ctx.sprint };
    },
    output: (ctx, out) => ({
      ...ctx,
      cwd: out.root,
      planningFolderRoot: out.root,
      planningSessionMdPath: out.sessionMdPath,
      planningRawTasksJsonPath: out.rawTasksJsonPath,
      planAddDirs: out.addDirs,
    }),
  });
}
