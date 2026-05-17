import { postTaskCheckUseCase, type PostTaskCheckProps } from '@src/business/task/post-task-check.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

export interface PostTaskCheckLeafDeps {
  readonly shellScriptRunner: ShellScriptRunner;
  readonly logger: Logger;
}

export interface PostTaskCheckLeafOpts {
  readonly cwd: AbsolutePath;
  readonly checkScript?: string;
  readonly timeoutMs?: number;
}

/**
 * Verify gate — runs the configured `checkScript` and enforces its outcome. Business policy
 * (three-outcome interpretation + stderr truncation) lives in
 * `@src/business/task/post-task-check.ts`; this leaf turns the outcome into a chain decision:
 *
 *   - `passed` / `skipped` — stamp `lastVerifyResult` and continue.
 *   - `verify-failed` — stamp `lastVerifyResult` AND set `lastBlockReason` so downstream
 *     `commit-task` skips (no commit on red) and `settle-attempt` blocks the task. The block
 *     reason names the exit code so the operator can see what failed without digging through
 *     the audit log.
 *
 * This leaf must sit BEFORE `commit-task` in the per-task chain — that's how the harness
 * enforces "tests must pass before we declare the task complete." The AI is told to run the
 * verify script itself via the prompt, but the harness is the source of truth.
 *
 * The element name carries the task id (`post-task-check-<taskId>`) so the execute dashboard can
 * attribute the entry to its owning task — matching every other per-task leaf.
 */
export const postTaskCheckLeaf = (
  deps: PostTaskCheckLeafDeps,
  opts: PostTaskCheckLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> => {
  const runShellScript: PostTaskCheckProps['runShellScript'] = (cwd, script, scriptOpts) =>
    deps.shellScriptRunner.run(cwd, script, scriptOpts);

  return leaf<ImplementCtx, void, ImplementCtx['lastVerifyResult']>(`post-task-check-${String(taskId)}`, {
    useCase: {
      execute: async () =>
        postTaskCheckUseCase({
          cwd: opts.cwd,
          ...(opts.checkScript !== undefined ? { checkScript: opts.checkScript } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          runShellScript,
          logger: deps.logger,
        }),
    },
    input: () => undefined,
    output: (ctx, out) => {
      if (out === undefined) return ctx;
      if (out.kind === 'verify-failed') {
        const exitCode = out.exitCode === null ? 'null' : String(out.exitCode);
        const reason = `verify script failed (exit=${exitCode}); harness will not commit on red`;
        return { ...ctx, lastVerifyResult: out, lastBlockReason: reason };
      }
      return { ...ctx, lastVerifyResult: out };
    },
  });
};
