import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';

/**
 * Context flowing through the close-sprint chain. Same shape as review's ctx but with no
 * feedback / round bookkeeping — close is a single one-shot transition, not a loop.
 *
 *  - `sprintId` — the route input; the load-and-assert sub-chain reads it.
 *  - `sprint` — filled by the load leaf; consumed by the transition leaf.
 *  - `aborted` — always undefined on this flow; the transition leaf reads it via the shared
 *    `TransitionSprintToDoneCtx` shape and defaults to `false`. No close path sets it.
 *  - `distillRequested` — opt-in gate (default `false`) set by the launcher's second HITL confirm.
 *    The pre-transition distill step reads it via the shared `DistillRequestedCtx` shape. Per
 *    This is the ONLY field the distill composition adds — the self-contained sub-chain carries its own
 *    ctx internally, so close-sprint's ctx is NOT widened with `entries` / `candidates`.
 *  - `tasks` — the sprint's full task set, filled by `load-tasks` ONLY when `deps.blockedTasksGate`
 *    is wired; `confirm-blocked-tasks` reads it to find any `blocked` entries. Stays `undefined`
 *    when the gate isn't wired (e.g. the CLI close path, which has no `InteractivePrompt`) —
 *    both the load leaf and the guard are omitted from the chain in that case.
 */
export interface CloseSprintCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
  readonly aborted?: boolean;
  readonly distillRequested: boolean;
  readonly tasks?: readonly Task[] | undefined;
}
