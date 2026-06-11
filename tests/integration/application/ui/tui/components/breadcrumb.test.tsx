/**
 * Breadcrumb — right-side project/sprint labels coalesce from ONE source.
 *
 * The right side has two sources of truth: the focused Execute run's pinned context
 * (`ui.setFocusedRunContext`) and the mutable global selection (`useSelection`). The contract:
 * when a run is focused, BOTH labels come from the run; otherwise BOTH come from the global
 * selection — never one from each. The regression we fence: a project-only focused run (no
 * sprint, e.g. detect-scripts) must NOT pair the run's project with a stale global sprint label.
 *
 * Drives the real contexts (no synthetic stubs) so the test exercises the same predicate
 * production renders through.
 *
 * audit 1-A: also asserts that the sprint StatusChip renders at ≥md (≥100 cols) and is
 * suppressed below md (<100 cols). Uses a `useTerminalSize` mock to control column count.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import { Breadcrumb } from '@src/application/ui/tui/components/breadcrumb.tsx';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { SelectionProvider, useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { UiStateProvider, useUiState, type FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

// Hoisted size control — vi.hoisted so the variable exists when the mock factory is hoisted.
const sizeRef = vi.hoisted(() => ({ columns: 100, rows: 24 }));
vi.mock('@src/application/ui/tui/runtime/use-terminal-size.ts', () => ({
  useTerminalSize: () => ({ columns: sizeRef.columns, rows: sizeRef.rows }),
}));

const PROJECT_ID_STR = '0193ed2b-aaaa-7abc-8def-0123456789ab';
const SPRINT_ID_STR = '0193ed2b-bbbb-7abc-8def-0123456789ab';

const parseProjectId = (): ProjectId => {
  const r = ProjectId.parse(PROJECT_ID_STR);
  if (!r.ok) throw new Error('invalid ProjectId fixture');
  return r.value;
};

const parseSprintId = (): SprintId => {
  const r = SprintId.parse(SPRINT_ID_STR);
  if (!r.ok) throw new Error('invalid SprintId fixture');
  return r.value;
};

interface SeedOptions {
  /** Global selection seeded before the focused-run context lands (the "stale" baseline). */
  readonly globalProjectLabel?: string;
  readonly globalSprintLabel?: string;
  /** Sprint lifecycle status to seed alongside the sprint label. */
  readonly globalSprintStatus?: SprintStatus;
  /** Focused-run context to pin, or `undefined` to leave no run focused. */
  readonly focusedRun?: FocusedRunCtx;
}

const Seed = ({
  globalProjectLabel,
  globalSprintLabel,
  globalSprintStatus,
  focusedRun,
}: SeedOptions): React.JSX.Element => {
  const selection = useSelection();
  const ui = useUiState();
  const setProjectRef = React.useRef(selection.setProject);
  setProjectRef.current = selection.setProject;
  const setSprintRef = React.useRef(selection.setSprint);
  setSprintRef.current = selection.setSprint;
  const setFocusedRef = React.useRef(ui.setFocusedRunContext);
  setFocusedRef.current = ui.setFocusedRunContext;
  React.useEffect(() => {
    if (globalProjectLabel !== undefined) setProjectRef.current(parseProjectId(), globalProjectLabel);
    if (globalSprintLabel !== undefined) setSprintRef.current(parseSprintId(), globalSprintLabel, globalSprintStatus);
    if (focusedRun !== undefined) setFocusedRef.current(focusedRun);
  }, [globalProjectLabel, globalSprintLabel, globalSprintStatus, focusedRun]);
  return <></>;
};

const Harness = (opts: SeedOptions): React.JSX.Element => (
  <UiStateProvider>
    <SelectionProvider>
      <RouterProvider initial={{ id: 'execute' }}>
        {(): React.JSX.Element => (
          <>
            <Seed {...opts} />
            <Breadcrumb />
          </>
        )}
      </RouterProvider>
    </SelectionProvider>
  </UiStateProvider>
);

describe('Breadcrumb — right-side label coalescing', () => {
  it('a project-only focused run does NOT show a stale global sprint label', async () => {
    sizeRef.columns = 100;
    const focusedRun: FocusedRunCtx = {
      projectLabel: 'run-project',
      sprintId: undefined,
      sprintLabel: undefined,
    };
    const { lastFrame, unmount } = render(
      <Harness globalProjectLabel="global-project" globalSprintLabel="stale-sprint" focusedRun={focusedRun} />
    );
    await tick(50);

    const frame = lastFrame() ?? '';
    // Project resolves from the focused run.
    expect(frame).toContain('run-project');
    expect(frame).not.toContain('global-project');
    // Sprint coalesces from the SAME source — the run has none, so no sprint label renders and
    // the stale global one must not leak through.
    expect(frame).not.toContain('stale-sprint');
    expect(frame).not.toContain('sprint:');

    unmount();
  });

  it('a focused run with a sprint shows both labels from the run, not the global selection', async () => {
    sizeRef.columns = 100;
    const focusedRun: FocusedRunCtx = {
      projectLabel: 'run-project',
      sprintId: parseSprintId(),
      sprintLabel: 'run-sprint',
    };
    const { lastFrame, unmount } = render(
      <Harness globalProjectLabel="global-project" globalSprintLabel="stale-sprint" focusedRun={focusedRun} />
    );
    await tick(50);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('run-project');
    expect(frame).toContain('run-sprint');
    expect(frame).not.toContain('global-project');
    expect(frame).not.toContain('stale-sprint');

    unmount();
  });

  it('with no focused run, both labels resolve from the global selection', async () => {
    sizeRef.columns = 100;
    const { lastFrame, unmount } = render(
      <Harness globalProjectLabel="global-project" globalSprintLabel="global-sprint" />
    );
    await tick(50);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('global-project');
    expect(frame).toContain('global-sprint');

    unmount();
  });
});

describe('Breadcrumb — sprint status chip (audit 1-A)', () => {
  it('renders the [S] picker affordance next to the sprint label (mirroring [P])', async () => {
    sizeRef.columns = 100;
    const { lastFrame, unmount } = render(
      <Harness globalProjectLabel="global-project" globalSprintLabel="global-sprint" />
    );
    await tick(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[P]');
    expect(frame).toContain('[S]');
    unmount();
  });

  it('renders the sprint status chip at ≥md (100 cols)', async () => {
    sizeRef.columns = 100;
    const { lastFrame, unmount } = render(
      <Harness globalProjectLabel="my-project" globalSprintLabel="my-sprint" globalSprintStatus="active" />
    );
    await tick(50);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('my-sprint');
    // StatusChip wraps the label in brackets and uppercases it.
    expect(frame).toContain('[ACTIVE]');
    unmount();
  });

  it('omits the sprint status chip below md (<100 cols)', async () => {
    sizeRef.columns = 80;
    const { lastFrame, unmount } = render(
      <Harness globalProjectLabel="my-project" globalSprintLabel="my-sprint" globalSprintStatus="active" />
    );
    await tick(50);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('my-sprint');
    // No chip at narrow width — avoids overflow on small terminals.
    expect(frame).not.toContain('[ACTIVE]');
    unmount();
  });

  it('does NOT show the status chip for a focused run even when the global status is set', async () => {
    sizeRef.columns = 120;
    const focusedRun: FocusedRunCtx = {
      projectLabel: 'run-project',
      sprintId: parseSprintId(),
      sprintLabel: 'run-sprint',
    };
    const { lastFrame, unmount } = render(
      <Harness
        globalProjectLabel="global-project"
        globalSprintLabel="global-sprint"
        globalSprintStatus="review"
        focusedRun={focusedRun}
      />
    );
    await tick(50);
    const frame = lastFrame() ?? '';
    // The focused run's sprint label shows but the global status chip must not leak through.
    expect(frame).toContain('run-sprint');
    expect(frame).not.toContain('[REVIEW]');
    unmount();
  });

  it('renders the correct chip kind for each status value', async () => {
    sizeRef.columns = 120;
    for (const [status, expected] of [
      ['draft', '[DRAFT]'],
      ['planned', '[PLANNED]'],
      ['active', '[ACTIVE]'],
      ['review', '[REVIEW]'],
    ] as const) {
      const { lastFrame, unmount } = render(
        <Harness globalProjectLabel="p" globalSprintLabel="s" globalSprintStatus={status as SprintStatus} />
      );
      await tick(50);

      expect(lastFrame() ?? '').toContain(expected);
      unmount();
    }
  });
});
