/**
 * Sprint detail — the sprint workspace.
 *
 * Layout:
 *  - Sprint header (name, status chip, slug, ticket/task counts, phase timeline with elapsed
 *    between sprint state transitions).
 *  - Phase-aware "Next action" card.
 *  - Tickets section (always first) — one bordered Jira-style card per ticket.
 *  - Tasks section — one bordered card per task, showing ticket reference, deps, repo, attempts.
 *
 * Inline expand-in-place: every ticket / task card stays in the list. Pressing ↵/o on the
 * focused card toggles its expansion inline (full description, requirements, referenced tasks
 * for tickets; steps, verification criteria, dependencies, attempt history for tasks) inside
 * the same border. Each card's expansion is tracked independently by stable id, so opening a
 * second card leaves the first one open. Cursor still moves between cards via ↑/↓ / j/k
 * across both sections without changing which cards are expanded. Pressing `esc` / `q` while
 * any card is expanded collapses every expansion in one action.
 *
 * Local keys:
 *   a       add ticket (draft only)
 *   d       remove the focused ticket (draft only) after a confirm
 *   ↑/↓     move the focus cursor across BOTH tickets and tasks
 *   ↵/o     expand / collapse the focused card inline
 *   esc/q   collapse every expanded card (back to list)
 *   v       open the focused task's evaluation verdict (`evaluation.md`); inert on a ticket row
 *           and on a task no attempt of which reached the evaluator
 *   n       open Flows, scoped to this sprint
 *
 * This file is the orchestrator's shell: it renders `ViewShell` around whatever
 * `useSprintDetailBody` (in `sprint-detail-internals/detail-body.tsx`) hands back. All
 * composition, loaders, side effects, and presentational sub-components (header card, tickets
 * pane, tasks pane, attempt sub-cards, prose helpers, footer hints, keymap) live under
 * `sprint-detail-internals/`.
 */

import React from 'react';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useSprintDetailBody } from '@src/application/ui/tui/views/sprint-detail-internals/detail-body.tsx';
import { SprintDetailContent } from '@src/application/ui/tui/views/sprint-detail-internals/detail-content.tsx';

export const SprintDetailView = (): React.JSX.Element => {
  const { subtitle, suppressScrollArrows, contentProps } = useSprintDetailBody();

  return (
    <ViewShell title="Sprint" subtitle={subtitle} suppressScrollArrows={suppressScrollArrows}>
      <SprintDetailContent {...contentProps} />
    </ViewShell>
  );
};
