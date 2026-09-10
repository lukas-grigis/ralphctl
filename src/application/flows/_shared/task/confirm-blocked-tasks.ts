import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';

/** Minimum context shape the leaf reads — the task set loaded by `loadTasksLeaf`. */
export interface ConfirmBlockedTasksCtx {
  readonly tasks?: readonly Task[] | undefined;
}

export interface ConfirmBlockedTasksLeafDeps {
  readonly interactive: InteractivePrompt;
}

interface ConfirmBlockedTasksInput {
  readonly blockedTasks: readonly Task[];
}

/** Longest task-name list spelled out before the tail collapses to "and N more". */
const MAX_NAMED_TASKS = 5;

const nameBlockedTasks = (blocked: readonly Task[]): string => {
  const named = blocked.slice(0, MAX_NAMED_TASKS).map((t) => t.name);
  const remainder = blocked.length - named.length;
  return remainder > 0 ? `${named.join(', ')}, and ${String(remainder)} more` : named.join(', ');
};

/**
 * Ask the operator to confirm transitioning a sprint to `done` despite blocked tasks, naming
 * them. Declining is treated exactly like a Ctrl+C at this step — an `AbortError` — so the
 * surrounding sequential chain stops before the transition leaf runs and the sprint stays
 * un-closed (re-runnable). Confirming falls through and the chain continues: this is a confirm,
 * not a refusal — descoping the remainder is a legitimate operator decision.
 */
const confirmBlockedTasksUseCase = async (
  deps: ConfirmBlockedTasksLeafDeps,
  input: ConfirmBlockedTasksInput
): Promise<Result<void, DomainError>> => {
  const { blockedTasks } = input;
  const message = [
    `${String(blockedTasks.length)} task(s) are blocked and will stay unreachable once this sprint is done:`,
    nameBlockedTasks(blockedTasks),
    '',
    'Close anyway?',
  ].join('\n');
  const confirmed = await deps.interactive.askConfirm({ message });
  if (!confirmed.ok) return Result.error(confirmed.error);
  if (confirmed.value !== true) {
    return Result.error(
      new AbortError({
        elementName: 'confirm-blocked-tasks',
        reason: 'Close cancelled — blocked tasks remain; the sprint was not closed.',
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Reusable in-chain HITL gate — the caller wraps this in a `guard` that only runs it when the
 * sprint has at least one `blocked` task. Reads `ctx.tasks` (populated by `loadTasksLeaf`,
 * spliced immediately before this leaf) and re-filters to `blocked` here rather than trusting
 * the guard's predicate result, so the leaf stays correct even if it is ever reused behind a
 * different gate.
 *
 * Generic over `<TCtx extends ConfirmBlockedTasksCtx>` — same composition pattern as
 * `loadTasksLeaf` / `transitionSprintToDoneLeaf` — so any flow whose context carries `tasks` can
 * reuse this leaf instead of each close-to-`done` path growing its own divergent confirm. Close
 * sprint and review both splice `loadTasksLeaf` + `guard(hasBlockedTask, confirmBlockedTasksLeaf)`
 * ahead of their respective `transitionSprintToDoneLeaf` for exactly this reason.
 *
 * @public
 */
export const confirmBlockedTasksLeaf = <TCtx extends ConfirmBlockedTasksCtx>(
  deps: ConfirmBlockedTasksLeafDeps,
  name = 'confirm-blocked-tasks'
): Element<TCtx> =>
  leaf<TCtx, ConfirmBlockedTasksInput, void>(name, {
    useCase: {
      execute: async (input) => confirmBlockedTasksUseCase(deps, input),
    },
    input: (ctx) => ({ blockedTasks: (ctx.tasks ?? []).filter((t) => t.status === 'blocked') }),
    output: (ctx) => ctx,
  });
