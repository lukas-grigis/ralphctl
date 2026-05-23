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
import { renderContractMd } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { generatorOutputContract } from '@src/application/flows/implement/leaves/generator.contract.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Per-task one-shot leaf — materialises the task's on-disk audit workspace at
 * `<sprintDir>/implement/<task-id>/` before the gen-eval loop runs. Writes two files:
 *
 *  - `prompt.md` — the rendered implement prompt for the FIRST attempt (no prior critique).
 *                  The actual per-turn prompt may differ if the loop retries with critique;
 *                  per-round prompts are not separately captured (audit by turn lives under
 *                  `rounds/<N>/`). The prompt body inlines the task's verification criteria under
 *                  a stable `## Done criteria` heading, so operators who want the criteria on
 *                  disk can grep the prompt directly.
 *  - `contract.md` — the canonical definition-of-done sidecar (task name, description,
 *                  per-criterion table with id / check / command / assertion). Both the
 *                  generator and evaluator templates point at this file via
 *                  `{{CONTRACT_PATH}}` so the AI reads the same authoritative spec each round.
 *
 * On resume the leaf overwrites both files because they derive from the current task spec — if
 * the task was edited between runs, the on-disk audit must reflect the new framing. Existing
 * `rounds/<N>/` subtrees are NEVER touched here.
 *
 * Audit [05] deletion: a separate `done-criteria.md` no longer ships. The criteria live on
 * `Task.verificationCriteria` (canonical), inside the per-round `prompt.md` (target), and the
 * persisted `contract.md` sidecar (audit / human-readable form).
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
        // Static-artifact outputDir points at round 1's generator dir. The live generator
        // leaf re-renders the prompt with the actual per-round outputDir before each spawn,
        // so this preview's path is correct for round 1 and indicative for later rounds.
        const previewOutputDir = AbsolutePath.parse(join(workspaceRoot, 'rounds', '1', 'generator'));
        if (!previewOutputDir.ok) return Result.error(previewOutputDir.error);

        const contractPath = join(workspaceRoot, 'contract.md');

        // build-task-workspace materialises a static prompt.md as an audit artifact only —
        // the live generator leaf re-reads `progress.md` immediately before each spawn, so
        // priorProgress is fixed empty here. The TUI / operator inspect this for the static
        // shape, not for the live in-context content.
        const prompt = await buildImplementPrompt(deps.templateLoader, {
          task: input.task,
          projectPath: String(opts.cwd),
          progressFile: String(opts.progressFile),
          priorProgress: '',
          contractPath,
          outputContractSection: renderContractSectionFor(generatorOutputContract, previewOutputDir.value),
          ...(opts.verifyScript !== undefined ? { verifyScript: opts.verifyScript } : {}),
        });
        if (!prompt.ok) return Result.error(prompt.error);

        const wrotePrompt = await writeOrError(join(workspaceRoot, 'prompt.md'), String(prompt.value));
        if (!wrotePrompt.ok) return Result.error(wrotePrompt.error);

        // Persist the canonical contract sidecar — overwritten on every leaf run so it always
        // reflects the current task spec. The generator and evaluator both read this file
        // (their prompts cite `{{CONTRACT_PATH}}`), so the harness owns the writer.
        const wroteContract = await writeOrError(contractPath, renderContractMd(input.task));
        if (!wroteContract.ok) return Result.error(wroteContract.error);

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
