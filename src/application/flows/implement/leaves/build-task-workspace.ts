import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildImplementPrompt } from '@src/integration/ai/prompts/implement/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Per-task one-shot leaf — materialises the task's on-disk audit workspace at
 * `<sprintDir>/implement/<task-id>/` before the gen-eval loop runs. Writes one file:
 *
 *  - `prompt.md` — the rendered implement prompt for the FIRST attempt (no prior critique).
 *                  The actual per-turn prompt may differ if the loop retries with critique;
 *                  per-round prompts are not separately captured (audit by turn lives under
 *                  `rounds/<N>/`). The prompt body inlines the task's verification criteria under
 *                  a stable `## Done criteria` heading, so operators who want the criteria on
 *                  disk can grep the prompt directly.
 *
 * On resume the leaf overwrites the prompt because it derives from the current task spec — if
 * the task was edited between runs, the on-disk audit must reflect the new framing. Existing
 * `rounds/<N>/` subtrees are NEVER touched here.
 *
 * Audit [05] deletion: a separate `done-criteria.md` no longer ships. The criteria live on
 * `Task.verificationCriteria` (canonical) and inside the per-round `prompt.md` (target); the
 * standalone file was the cheapest of three places to remove.
 */

export interface BuildTaskWorkspaceLeafDeps {
  readonly templateLoader: TemplateLoader;
  readonly logger: Logger;
}

export interface BuildTaskWorkspaceLeafOpts {
  readonly sprintDir: AbsolutePath;
  readonly cwd: AbsolutePath;
  readonly progressFile: AbsolutePath;
  readonly verifyScript?: string;
}

interface LeafInput {
  readonly task: Task;
}

interface LeafOutput {
  readonly workspaceRoot: AbsolutePath;
}

const writeOrError = async (path: string, content: string): Promise<Result<void, StorageError>> => {
  try {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, content, 'utf8');
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to write task workspace file: ${path}`,
        path,
        cause,
      })
    );
  }
};

export const buildTaskWorkspaceLeaf = (
  deps: BuildTaskWorkspaceLeafDeps,
  opts: BuildTaskWorkspaceLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, LeafInput, LeafOutput>(`build-task-workspace-${String(taskId)}`, {
    useCase: {
      execute: async (input) => {
        const log = deps.logger.named('implement.workspace');
        const workspaceRoot = join(String(opts.sprintDir), 'implement', String(input.task.id));

        // build-task-workspace materialises a static prompt.md as an audit artifact only —
        // the live generator leaf re-reads `progress.md` immediately before each spawn, so
        // priorProgress is fixed empty here. The TUI / operator inspect this for the static
        // shape, not for the live in-context content.
        const prompt = await buildImplementPrompt(deps.templateLoader, {
          task: input.task,
          projectPath: String(opts.cwd),
          progressFile: String(opts.progressFile),
          priorProgress: '',
          outputContractSection: renderContractSectionFor(generatorOutputContract),
          ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
        });
        if (!prompt.ok) return Result.error(prompt.error);

        const wrotePrompt = await writeOrError(join(workspaceRoot, 'prompt.md'), String(prompt.value));
        if (!wrotePrompt.ok) return Result.error(wrotePrompt.error);

        log.debug('task workspace built', { taskId: input.task.id, workspaceRoot });
        const parsedRoot = AbsolutePath.parse(workspaceRoot);
        if (!parsedRoot.ok) return Result.error(parsedRoot.error);
        return Result.ok({ workspaceRoot: parsedRoot.value });
      },
    },
    input: (ctx) => {
      const task = (ctx.tasks ?? []).find((t) => t.id === taskId);
      if (task === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-build-task-workspace',
          attemptedAction: `build-task-workspace-${String(taskId)}`,
          message: `build-task-workspace-${String(taskId)}: task not found in ctx.tasks`,
        });
      }
      return { task };
    },
    output: (ctx, out) => ({ ...ctx, taskWorkspaceRoot: out.workspaceRoot }),
  });
