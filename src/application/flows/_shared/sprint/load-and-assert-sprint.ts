import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import type { Element } from '@src/application/chain/element.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import { type LoadSprintCtx, loadSprintLeaf } from '@src/application/flows/_shared/sprint/load.ts';
import {
  type AssertSprintStatusCtx,
  assertSprintStatusLeaf,
} from '@src/application/flows/_shared/sprint/assert-status.ts';

export interface LoadAndAssertSprintDeps {
  readonly sprintRepo: SprintRepository;
}

/**
 * Sub-chain composing `loadSprintLeaf` + `assertSprintStatusLeaf` — the recurring "fetch the
 * sprint and refuse if it's in the wrong state" pattern shared by add-tickets / refine / plan /
 * implement. Each consumer passes the status set its flow accepts (e.g. refine → `['draft']`,
 * implement → `['active']`).
 *
 * Returns `Element<TCtx>` (not the concrete `Sequential`) so the sub-chain's internals are an
 * implementation detail — composition can change without breaking callers.
 */
export const loadAndAssertSprintSubChain = <TCtx extends LoadSprintCtx & AssertSprintStatusCtx>(
  deps: LoadAndAssertSprintDeps,
  allowedStatuses: readonly SprintStatus[],
  name = 'load-and-assert-sprint'
): Element<TCtx> =>
  sequential<TCtx>(name, [
    loadSprintLeaf<TCtx>({ sprintRepo: deps.sprintRepo }),
    assertSprintStatusLeaf<TCtx>(allowedStatuses),
  ]);
