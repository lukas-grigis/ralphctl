/**
 * LocationBar — row 1 of the frame. Right-side labels coalesce from ONE source (the focused run's
 * pinned context, else the global selection — never one from each); the row is always exactly one
 * line and fits in order: subtitle → trail → [STATUS] chip → names.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { LocationBar } from '@src/application/ui/tui/components/location-bar.tsx';
import { RouterProvider, useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { SelectionProvider, useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { UiStateProvider, useUiState, type FocusedRunCtx } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { ViewTitleProvider, usePublishViewTitle } from '@src/application/ui/tui/runtime/view-title-context.tsx';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { projectId } from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const PID = projectId('0193ed2b-aaaa-7abc-8def-0123456789ab');
const SID = ((): SprintId => {
  const r = SprintId.parse('0193ed2b-bbbb-7abc-8def-0123456789ab');
  if (!r.ok) throw new Error('bad sprint id');
  return r.value;
})();

interface Opts {
  readonly stack: readonly ViewEntry[];
  readonly project?: string;
  readonly sprint?: string;
  readonly status?: SprintStatus;
  readonly focusedRun?: FocusedRunCtx;
  readonly subtitle?: string;
}

/** Walks the router to `stack`, seeds the selection / focused run, and publishes a view title. */
const Setup = ({ stack, project, sprint, status, focusedRun, subtitle }: Opts): React.JSX.Element => {
  const router = useRouter();
  const selection = useSelection();
  const ui = useUiState();
  const done = React.useRef(false);
  React.useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (project !== undefined) selection.setProject(PID, project);
    if (sprint !== undefined) selection.setSprint(SID, sprint, status);
    if (focusedRun !== undefined) ui.setFocusedRunContext(focusedRun);
    for (const entry of stack.slice(1)) router.push(entry);
  }, [router, selection, ui, stack, project, sprint, status, focusedRun]);
  usePublishViewTitle({ title: 'x', subtitle });
  return <></>;
};

const mount = (opts: Opts, columns = 80): ReturnType<typeof renderAtSize> =>
  renderAtSize(
    <UiStateProvider>
      <SelectionProvider>
        <RouterProvider initial={opts.stack[0] ?? { id: 'home' }}>
          {() => (
            <ViewTitleProvider>
              <Setup {...opts} />
              <LocationBar />
            </ViewTitleProvider>
          )}
        </RouterProvider>
      </SelectionProvider>
    </UiStateProvider>,
    { columns, rows: 24 }
  );

const rowsOf = (frame: string | undefined): string[] => (frame ?? '').split('\n').filter((l) => l.trim() !== '');

describe('LocationBar', () => {
  it('at 80 columns with a 30-char project and a sprint-detail stack: one row, no split chip, chip dropped before names', async () => {
    const project = 'Quarterly Reporting Platform 1';
    expect(project).toHaveLength(30);
    const r = mount(
      {
        stack: [{ id: 'sprints' }, { id: 'sprint-detail', props: { sprintName: 'ready to implement · 36bf2290' } }],
        project,
        sprint: 'ready to implement · 36bf2290',
        status: 'active',
        subtitle: 'ready to implement',
      },
      80
    );
    await tick(60);
    const frame = r.lastFrame();
    const lines = rowsOf(frame);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect([...line].length).toBeLessThanOrEqual(80);
    expect(line).toContain('▣ ');
    // Never a split chip — the chip is whole or absent.
    expect(line).not.toMatch(/\[[A-Z ]+(?!\])$/);
    expect(line.includes('[ACTIVE]') || !line.includes('[')).toBe(true);
    // Fit order: the chip goes before any name is shortened — so a row that still shows the chip
    // has whole names, and a row with a shortened name has already lost the chip.
    const right = line.slice(line.indexOf('Quarterly'));
    if (line.includes('[ACTIVE]')) expect(right).not.toContain('…');
    else expect(line).not.toContain('[');
    r.unmount();
  });

  it('renders section root, crumb trail and the right-hand context at 100 columns', async () => {
    const r = mount(
      {
        stack: [{ id: 'sprints' }, { id: 'sprint-detail', props: { sprintName: 'sprint one' } }],
        project: 'Alpha',
        sprint: 'sprint one',
        status: 'active',
      },
      100
    );
    await tick(60);
    const line = rowsOf(r.lastFrame())[0] ?? '';
    expect(line).toContain('▣ Sprints › sprint one');
    expect(line).toContain('Alpha › sprint one [ACTIVE]');
    r.unmount();
  });

  it('spells out `project` / `sprint` and `S switch` at lg', async () => {
    const r = mount({ stack: [{ id: 'home' }], project: 'Alpha', sprint: 'one', status: 'draft' }, 160);
    await tick(60);
    const line = rowsOf(r.lastFrame())[0] ?? '';
    expect(line).toContain('project Alpha › sprint one [DRAFT]');
    expect(line).toContain('S switch');
    r.unmount();
  });

  it('a project-only focused run does NOT pair its project with a stale global sprint', async () => {
    const r = mount(
      {
        stack: [{ id: 'sessions' }, { id: 'execute' }],
        project: 'global-project',
        sprint: 'stale-sprint',
        focusedRun: { projectLabel: 'run-project', sprintId: undefined, sprintLabel: undefined },
      },
      100
    );
    await tick(60);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('run-project');
    expect(frame).not.toContain('global-project');
    expect(frame).not.toContain('stale-sprint');
    r.unmount();
  });

  it('a focused run with a sprint takes BOTH labels from the run and no status chip', async () => {
    const r = mount(
      {
        stack: [{ id: 'sessions' }, { id: 'execute' }],
        project: 'global-project',
        sprint: 'stale-sprint',
        status: 'active',
        focusedRun: { projectLabel: 'run-project', sprintId: SID, sprintLabel: 'run-sprint' },
      },
      100
    );
    await tick(60);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('run-project › run-sprint');
    expect(frame).not.toContain('[ACTIVE]');
    expect(frame).not.toContain('stale-sprint');
    r.unmount();
  });

  it('is hidden while no section is active (first-run wizard)', async () => {
    const r = mount({ stack: [{ id: 'welcome' }] }, 100);
    await tick(60);
    expect(rowsOf(r.lastFrame())).toHaveLength(0);
    r.unmount();
  });
});
