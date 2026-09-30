/**
 * Sprints list — opening a sprint is a BROWSE. ↵ pushes sprint-detail (labelled from the route's
 * own sprint name) without touching the selection; `m` is the explicit make-current and says so.
 */

import React from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const SEEDED = 'seeded-sprint-id' as unknown as SprintId;

const SelectionProbe = (): React.JSX.Element => {
  const selection = useSelection();
  return <Text>{`selected=${selection.sprintId ?? 'none'}`}</Text>;
};

const setup = (): { result: ReturnType<typeof renderView>['result']; routes: ViewEntry[]; sprintId: string } => {
  const sprint = makeDraftSprint({ name: 'Browse Sprint' });
  const deps = {
    sprintRepo: { list: async () => Result.ok([sprint]), findById: async () => Result.ok(sprint) },
    taskRepo: { findBySprintId: async () => Result.ok([]) },
    projectRepo: {},
    sprintExecutionRepo: {},
    settingsRepo: {},
    logger: noopLogger,
  } as unknown as AppDeps;
  const routes: ViewEntry[] = [];
  const { result } = renderView(
    <>
      <SprintsView />
      <SelectionProbe />
    </>,
    {
      deps,
      initial: { id: 'sprints' },
      selection: { sprintId: SEEDED, sprintLabel: 'Seeded' },
      onRoute: (e) => routes.push(e),
    }
  );
  return { result, routes, sprintId: String(sprint.id) };
};

describe('SprintsView — browse vs make current', () => {
  it('↵ opens the detail with the sprint name and leaves the selection unchanged through esc', async () => {
    const { result, routes } = setup();
    await waitForViewReady(result, (f) => f.includes('Browse Sprint'));

    result.stdin.write(ENTER);
    await tick(60);
    const pushed = routes.find((r) => r.id === 'sprint-detail');
    expect(pushed?.props?.sprintName).toBe('Browse Sprint');
    expect(result.lastFrame() ?? '').toContain(`selected=${String(SEEDED)}`);

    result.stdin.write(ESC);
    await tick(60);
    expect(result.lastFrame() ?? '').toContain(`selected=${String(SEEDED)}`);
    result.unmount();
  });

  it('m makes the focused sprint current and confirms with "✓ now on <name>"', async () => {
    const { result, sprintId } = setup();
    await waitForViewReady(result, (f) => f.includes('Browse Sprint'));

    result.stdin.write('m');
    await tick(60);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain(`selected=${sprintId}`);
    expect(frame).toContain('✓ now on Browse Sprint');
    result.unmount();
  });
});
