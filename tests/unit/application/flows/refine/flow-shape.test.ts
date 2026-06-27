import { describe, expect, it } from 'vitest';

import type { PendingTicket } from '@src/domain/entity/ticket.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRefineFlow, type CreateRefineFlowOpts } from '@src/application/flows/refine/flow.ts';
import type { RefineDeps } from '@src/application/flows/refine/deps.ts';

import { absolutePath, makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';

/**
 * Topology fence for the refine chain. `createRefineFlow` only CONSTRUCTS the element tree here —
 * no leaf executes — so the deps can be an inert cast: every leaf factory captures its deps in a
 * closure read lazily inside `execute`, which these tests never call (same rationale as the
 * implement flow-shape fence). This asserts the OBSERVABLE chain shape (the thing the TUI walks to
 * render the upfront plan) deterministically fails if a leaf is dropped, added, or reordered.
 */
const names = <T>(el: Element<T>): readonly string[] => [el.name, ...(el.children ?? []).flatMap((c) => names(c))];

const stubDeps = (): RefineDeps => ({}) as unknown as RefineDeps;

const makeOpts = (pendingTickets: readonly PendingTicket[]): CreateRefineFlowOpts => ({
  sprintId: makeDraftSprint().id,
  pendingTickets,
  providerId: 'claude-code',
  model: 'claude-opus-4-8',
  refinementRoot: absolutePath('/sprints/s1/refinement'),
});

describe('createRefineFlow — chain-shape fence', () => {
  it('builds the exact leaf topology, in order, for a single ticket', () => {
    const ticket = makePendingTicket({ title: 'do-work' });
    const id = String(ticket.id);

    expect(names(createRefineFlow(stubDeps(), makeOpts([ticket])))).toStrictEqual([
      'refine',
      'load-and-assert-sprint',
      'load-sprint',
      'assert-sprint-status',
      'refine-tickets',
      `refine-${id}`,
      `fetch-issue-context-${id}`,
      `build-refine-unit-${id}`,
      `render-prompt-to-file-${id}`,
      `install-skills-${id}`,
      `stamp-meta-refine-${id}`,
      `refine-ticket-${id}`,
      `uninstall-skills-${id}`,
      `save-after-${id}`,
    ]);
  });

  it('fans out one refine-<id> sub-chain per pending ticket, in order', () => {
    const t1 = makePendingTicket({ title: 't1' });
    const t2 = makePendingTicket({ title: 't2' });

    const top = createRefineFlow(stubDeps(), makeOpts([t1, t2]));
    const ticketsNode = (top.children ?? []).find((c) => c.name === 'refine-tickets');

    expect((ticketsNode?.children ?? []).map((c) => c.name)).toStrictEqual([
      `refine-${String(t1.id)}`,
      `refine-${String(t2.id)}`,
    ]);
  });
});
