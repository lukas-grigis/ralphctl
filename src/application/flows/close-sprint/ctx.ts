import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

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
 */
export interface CloseSprintCtx {
  readonly sprintId: SprintId;
  readonly sprint?: Sprint;
  readonly aborted?: boolean;
  readonly distillRequested: boolean;
}
