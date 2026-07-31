import { describe, expect, it } from 'vitest';

import type { Element } from '@src/application/chain/element.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ReviewDeps } from '@src/application/flows/review/deps.ts';
import { createReviewFlow, type CreateReviewFlowOpts } from '@src/application/flows/review/flow.ts';

import { absolutePath } from '@tests/fixtures/domain.ts';

/**
 * Topology fence for the review chain — mirrors the construction-only pattern the other AI-driven
 * flows use (readiness/flow-shape.test.ts, implement/flow-shape.test.ts, …): flatten the element
 * tree in DFS order and assert on the name list. No leaf ever executes, so every dep can be an
 * inert cast — `createReviewFlow` never reads a dep field eagerly (unlike implement's
 * `config.harness.*` read), it only closes over them inside leaf factories and, for `deps.distill`,
 * calls `createDistillStep` — which itself only stores its `deps`/`opts` in closure, never invokes
 * them at construction (see `distill-step.ts`). Locks in the loop + guard + optional-distill-splice
 * composition `flow.ts`'s own doc comment describes, so a future reorder fails fast and clearly.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (opts: { readonly withDistill?: boolean } = {}): ReviewDeps =>
  ({
    ...(opts.withDistill === true ? { distill: { deps: {}, opts: {} } } : {}),
  }) as unknown as ReviewDeps;

const makeOpts = (): CreateReviewFlowOpts => ({
  sprintId: SprintId.generate(),
  sprintDir: absolutePath('/sprints/s1'),
  reviewRoot: absolutePath('/sprints/s1/review'),
  commitCwd: absolutePath('/repos/main'),
  additionalRoots: [absolutePath('/repos/main')],
  repositoriesBlock: '- main-repo',
  feedbackFile: absolutePath('/sprints/s1/feedback.md'),
});

describe('createReviewFlow — chain-topology fence', () => {
  it('builds the exact leaf topology, in order, when no distill step is wired', () => {
    expect(names(createReviewFlow(stubDeps(), makeOpts()))).toStrictEqual([
      'with-repo-lock(review)',
      'review',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'ensure-feedback-file',
      'review-loop',
      'review-round',
      'review-settled',
      'review-settle',
      'transition-sprint-to-done',
    ]);
  });

  it('splices distill-learnings-step into review-settle, immediately BEFORE the done transition, when deps.distill is present', () => {
    expect(names(createReviewFlow(stubDeps({ withDistill: true }), makeOpts()))).toStrictEqual([
      'with-repo-lock(review)',
      'review',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'ensure-feedback-file',
      'review-loop',
      'review-round',
      'review-settled',
      'review-settle',
      'distill-learnings-step',
      'transition-sprint-to-done',
    ]);
  });

  it('wraps the WHOLE chain in exactly one with-repo-lock, never inside review-settle or the loop body', () => {
    const top = createReviewFlow(stubDeps(), makeOpts());

    expect(top.name).toBe('with-repo-lock(review)');
    expect(top.children?.length).toBe(1);
    const chain = top.children?.[0];
    expect(chain?.name).toBe('review');

    // Only the top node's name carries the `with-repo-lock(...)` wrapper — it never recurs deeper.
    expect(names(top).filter((n) => n.startsWith('with-repo-lock('))).toStrictEqual(['with-repo-lock(review)']);
  });

  it('exposes review-loop wrapping exactly one review-round body (the loop primitive never unrolls iterations at construction)', () => {
    const chain = createReviewFlow(stubDeps(), makeOpts()).children?.[0];
    const loopNode = chain?.children?.find((c) => c.name === 'review-loop');

    expect(loopNode?.children?.length).toBe(1);
    expect(loopNode?.children?.[0]?.name).toBe('review-round');
  });

  it('gates BOTH the transition and the optional distill step behind the SAME review-settled guard', () => {
    const chain = createReviewFlow(stubDeps({ withDistill: true }), makeOpts()).children?.[0];
    const guardNode = chain?.children?.find((c) => c.name === 'review-settled');
    const settleBody = guardNode?.children?.[0];

    expect(settleBody?.name).toBe('review-settle');
    expect(settleBody?.children?.map((c) => c.name)).toStrictEqual([
      'distill-learnings-step',
      'transition-sprint-to-done',
    ]);
  });
});
