import { describe, expect, it } from 'vitest';

import type { Element } from '@src/application/chain/element.ts';
import { createPlanFlow, type CreatePlanFlowOpts } from '@src/application/flows/plan/flow.ts';
import type { PlanDeps } from '@src/application/flows/plan/deps.ts';

import { absolutePath, FIXED_PROJECT_ID, makeDraftSprint } from '@tests/fixtures/domain.ts';

/**
 * Topology fence for the plan chain. Construction-only: every leaf factory captures its deps in a
 * closure read lazily inside `execute`, never called here, so the deps cast is sound (same rationale
 * as the implement flow-shape fence). Fails deterministically if a leaf is dropped, added, or
 * reordered.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (): PlanDeps => ({}) as unknown as PlanDeps;

const makeOpts = (): CreatePlanFlowOpts => ({
  sprintId: makeDraftSprint().id,
  projectId: FIXED_PROJECT_ID,
  providerId: 'claude-code',
  model: 'claude-opus-4-8',
  maxAttempts: 3,
  planRoot: absolutePath('/sprints/s1/plan'),
});

describe('createPlanFlow — chain-shape fence', () => {
  it('builds the exact leaf topology, in order', () => {
    expect(names(createPlanFlow(stubDeps(), makeOpts()))).toStrictEqual([
      'plan',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'load-project',
      'load-sprint-execution',
      'load-tasks',
      'build-plan-unit',
      'render-prompt-to-file',
      'install-skills',
      'stamp-meta-plan',
      'call-planner-interactive',
      'uninstall-skills',
      'save-tasks',
      'save-sprint',
    ]);
  });
});
