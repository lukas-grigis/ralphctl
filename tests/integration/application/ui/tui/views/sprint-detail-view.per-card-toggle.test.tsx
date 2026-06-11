/**
 * Sprint-detail view — per-card expand/collapse keyed by stable id.
 *
 * Each ticket / task card tracks its expansion independently. These tests guard the
 * properties that the prior single-slot openIdx could not honour:
 *
 *  - opening a second card leaves the first one expanded;
 *  - closing one expanded card leaves the other still expanded;
 *  - pressing esc with at least one card open collapses every expansion in a single action;
 *  - moving the focus cursor with j/k does not change which cards are expanded;
 *  - removing a card above the expanded ones does not migrate expansion onto a different
 *    card (identity stability: expansion is bound to the item's id, not its list index).
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { ESC, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeApprovedTicket, makeDraftSprint } from '@tests/fixtures/domain.ts';

const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const makeTicket = (id: string, title: string, description: string): unknown => ({
  id,
  title,
  status: 'approved',
  description,
  requirements: `requirements for ${title}`,
});

const makeSprintWithTickets = (tickets: readonly unknown[]): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj-fixture' as never,
    status: 'planned',
    tickets,
  }) as unknown as Sprint;

const stubReadOnlyDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

describe('SprintDetailView — per-card expand/collapse', () => {
  it('opens two cards independently — both remain expanded', async () => {
    const sprint = makeSprintWithTickets([
      makeTicket('ticket-a', 'alpha card', 'alpha-only-marker-line-in-description'),
      makeTicket('ticket-b', 'bravo card', 'bravo-only-marker-line-in-description'),
    ]);
    const { result } = renderView(<SprintDetailView />, { deps: stubReadOnlyDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('alpha card'));

    // Expand the first ticket (cursor starts at idx 0).
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for alpha card'));
    // Move to the second ticket and expand it without collapsing the first.
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for bravo card'));

    const frame = result.lastFrame() ?? '';
    // Both expanded views render their per-ticket Requirements heading; if either card
    // collapsed back to its preview, the heading for that ticket would not appear.
    expect(frame).toContain('requirements for alpha card');
    expect(frame).toContain('requirements for bravo card');
  });

  it('closing one expanded card leaves the other expanded', async () => {
    const sprint = makeSprintWithTickets([
      makeTicket('ticket-a', 'alpha card', 'alpha-only-marker-line-in-description'),
      makeTicket('ticket-b', 'bravo card', 'bravo-only-marker-line-in-description'),
    ]);
    const { result } = renderView(<SprintDetailView />, { deps: stubReadOnlyDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('alpha card'));

    // Open card 0.
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for alpha card'));
    // Move to card 1 and open it.
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for bravo card'));
    // Move back to card 0 and toggle it closed.
    result.stdin.write('k');
    await tick(40);
    result.stdin.write('o');
    await tick(40);

    const frame = result.lastFrame() ?? '';
    // Card 0's requirements heading should be gone; card 1's must remain.
    expect(frame).not.toContain('requirements for alpha card');
    expect(frame).toContain('requirements for bravo card');
  });

  it('pressing esc with multiple cards expanded collapses every card in a single action', async () => {
    const sprint = makeSprintWithTickets([
      makeTicket('ticket-a', 'alpha card', 'alpha-only-marker-line-in-description'),
      makeTicket('ticket-b', 'bravo card', 'bravo-only-marker-line-in-description'),
    ]);
    const { result } = renderView(<SprintDetailView />, { deps: stubReadOnlyDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('alpha card'));

    // Expand both cards.
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for alpha card'));
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for bravo card'));

    // Confirm pre-condition: both cards expanded.
    let frame = result.lastFrame() ?? '';
    expect(frame).toContain('requirements for alpha card');
    expect(frame).toContain('requirements for bravo card');

    // One Esc must clear the entire openIds set.
    result.stdin.write(ESC);
    await tick(40);

    frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('requirements for alpha card');
    expect(frame).not.toContain('requirements for bravo card');
  });

  it('moving the cursor with j/k does not change which cards are expanded', async () => {
    const sprint = makeSprintWithTickets([
      makeTicket('ticket-a', 'alpha card', 'alpha-only-marker-line-in-description'),
      makeTicket('ticket-b', 'bravo card', 'bravo-only-marker-line-in-description'),
      makeTicket('ticket-c', 'charlie card', 'charlie-only-marker-line-in-description'),
    ]);
    const { result } = renderView(<SprintDetailView />, { deps: stubReadOnlyDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('alpha card'));

    // Expand only the first card.
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for alpha card'));

    // Navigate cursor up and down across all three cards.
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('k');
    await tick(40);
    result.stdin.write('k');
    await tick(40);

    const frame = result.lastFrame() ?? '';
    // The alpha card must remain expanded throughout cursor movement; the others must not
    // have auto-expanded just because the cursor passed over them.
    expect(frame).toContain('requirements for alpha card');
    expect(frame).not.toContain('requirements for bravo card');
    expect(frame).not.toContain('requirements for charlie card');
  });

  it('removing a ticket above expanded cards does not migrate expansion to a different row', async () => {
    // Build a draft sprint with three real approved tickets so the `d` removal flow can
    // travel through the genuine `removeTicket` use-case. The expansion is keyed by id, so
    // dropping the middle ticket must leave the OTHER two cards visibly expanded — a list-
    // index-based implementation would mis-track expansion onto whichever rows now sit at
    // the previously-recorded indices.
    const alpha = makeApprovedTicket({
      title: 'alpha card',
      requirements: 'requirements for alpha card',
    });
    const bravo = makeApprovedTicket({
      title: 'bravo card',
      requirements: 'requirements for bravo card',
    });
    const charlie = makeApprovedTicket({
      title: 'charlie card',
      requirements: 'requirements for charlie card',
    });
    let storedSprint: Sprint = makeDraftSprint({ tickets: [alpha, bravo, charlie] }) as unknown as Sprint;

    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(storedSprint);
        },
        async save(s: Sprint) {
          storedSprint = s;
          return Result.ok(s);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const initialWithRealId = { id: 'sprint-detail', props: { sprintId: storedSprint.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithRealId });
    await waitForViewReady(result, (f) => f.includes('alpha card'));

    // Open card 0 (alpha).
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for alpha card'));
    // Move down twice to card 2 (charlie) and open it.
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('o');
    await waitFor(() => (result.lastFrame() ?? '').includes('requirements for charlie card'));

    // Pre-condition: alpha and charlie expanded; bravo collapsed.
    let frame = result.lastFrame() ?? '';
    expect(frame).toContain('requirements for alpha card');
    expect(frame).not.toContain('requirements for bravo card');
    expect(frame).toContain('requirements for charlie card');

    // Move cursor up one to bravo (the middle ticket) and remove it via d → y. The confirm
    // prompt mounts, then on `y` the remove-ticket flow fires + reload pulls a fresh sprint
    // without bravo. Expansion state on alpha + charlie must survive the reload — the reload
    // briefly flips the view to a Loading spinner while the new bundle resolves, so we poll
    // until the cards are back before asserting.
    result.stdin.write('k');
    await tick(40);
    result.stdin.write('d');
    await waitFor(() => (result.lastFrame() ?? '').includes('Remove ticket'));
    result.stdin.write('y');
    await waitFor(() => {
      const f = result.lastFrame() ?? '';
      return f.includes('alpha card') && f.includes('charlie card') && !f.includes('Loading');
    });

    frame = result.lastFrame() ?? '';
    // The two surviving cards (alpha + charlie) keep their expansion; bravo is gone from the
    // list entirely, so its requirements line must no longer appear anywhere.
    expect(frame).toContain('requirements for alpha card');
    expect(frame).toContain('requirements for charlie card');
    expect(frame).not.toContain('requirements for bravo card');
  });
});
