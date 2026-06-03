/**
 * Smoke + windowing tests for PickProjectView. The view is the launch entry screen: it lists
 * every project, pre-seeds the cursor to the persisted last-selection, routes Home on Enter,
 * and pushes the create-project wizard on `+` / `c`.
 *
 * Since CS-M-pickproject it renders through the windowed-list primitive (cursor keyed on
 * `project.id`), so these tests assert the focused project stays inside the rendered window
 * even past the viewport, that selection still works, and that the create binding is intact.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { PickProjectView } from '@src/application/ui/tui/views/pick-project-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { makeProject, projectId } from '@tests/fixtures/domain.ts';
import { DOWN, END, ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const stubDeps = (projects: readonly Project[]): AppDeps =>
  ({
    projectRepo: {
      async list() {
        return Result.ok(projects);
      },
    },
  }) as unknown as AppDeps;

/** Build N distinct projects with stable, ordered ids + display names (`Project NN`). */
const makeProjects = (n: number): readonly Project[] =>
  Array.from({ length: n }, (_, i) => {
    const idx = i + 1;
    const suffix = String(idx).padStart(2, '0');
    return makeProject({
      id: projectId(`01900000-0000-7000-8000-0000000001${suffix}`),
      slug: `project-${suffix}`,
      displayName: `Project ${suffix}`,
    });
  });

/** The detail sub-line under the focused project: `↳ <slug> · N repo`. */
const focusedDetailLine = (frame: string, slug: string): string | undefined =>
  frame.split('\n').find((l) => l.includes(slug) && l.includes('repo'));

describe('PickProjectView', () => {
  it('renders every project name (small list, no overflow)', async () => {
    const projects = makeProjects(3);
    const { result } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('Project 01'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Project 01');
    expect(frame).toContain('Project 02');
    expect(frame).toContain('Project 03');
    expect(frame).toContain('3 projects');
  });

  it('empty project list shows the create-prompt card', async () => {
    const { result } = renderView(<PickProjectView />, {
      deps: stubDeps([]),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('No projects yet'));
    expect(result.lastFrame() ?? '').toContain('No projects yet');
  });

  it('Enter on the focused project selects it and routes Home', async () => {
    const projects = makeProjects(3);
    const { result, routeIds } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('Project 01'));
    result.stdin.write(ENTER);
    await tick();
    expect(routeIds()).toContain('home');
  });

  it('the focused project stays visible after paging past the viewport (windowing)', async () => {
    // 40 projects far exceeds any breakpoint's visibleRows, so a flat render would push the
    // bottom rows off-window. End jumps the cursor to the last project; the windowed list must
    // keep that focused row — with its detail sub-line — inside the rendered frame.
    const projects = makeProjects(40);
    const { result } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('Project 01'));

    // Top of the list: the first project's detail line is visible, the last one is not.
    expect(focusedDetailLine(result.lastFrame() ?? '', 'project-01')).toBeDefined();
    expect(result.lastFrame() ?? '').not.toContain('Project 40');

    // Jump to the end — the focused project (and its ↳ detail line) must now be on-screen, and
    // a ▴ "N more" overflow cue must mark the rows scrolled above.
    result.stdin.write(END);
    await tick();
    const atBottom = result.lastFrame() ?? '';
    expect(atBottom).toContain('Project 40');
    expect(focusedDetailLine(atBottom, 'project-40')).toBeDefined();
    expect(atBottom).toContain('more');
  });

  it('arrow-down moves the focus marker without losing the focused row off-window', async () => {
    const projects = makeProjects(40);
    const { result } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('Project 01'));
    // Initial focus detail line is project-01.
    expect(focusedDetailLine(result.lastFrame() ?? '', 'project-01')).toBeDefined();
    result.stdin.write(DOWN);
    await tick();
    const after = result.lastFrame() ?? '';
    // Focus advanced to project-02 — its detail line is now the rendered one.
    expect(focusedDetailLine(after, 'project-02')).toBeDefined();
    expect(focusedDetailLine(after, 'project-01')).toBeUndefined();
  });

  it('pre-seeds the cursor to the persisted last-selected project even when it is mid-list', async () => {
    const projects = makeProjects(40);
    const selected = projects[25]!;
    const { result } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
      selection: { projectId: selected.id, projectLabel: selected.displayName },
    });
    await waitForViewReady(result, (f) => f.includes(selected.displayName));
    const frame = result.lastFrame() ?? '';
    // The seeded selection is mid-list (index 25) yet windowed into view with its detail line.
    expect(frame).toContain(selected.displayName);
    expect(focusedDetailLine(frame, selected.slug)).toBeDefined();
  });

  it('+ pushes the create-project wizard', async () => {
    const projects = makeProjects(3);
    const { result, routeIds } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('Project 01'));
    result.stdin.write('+');
    await tick();
    expect(routeIds()).toContain('create-project');
  });

  it('c also pushes the create-project wizard (legacy binding preserved)', async () => {
    const projects = makeProjects(3);
    const { result, routeIds } = renderView(<PickProjectView />, {
      deps: stubDeps(projects),
      initial: { id: 'pick-project' },
    });
    await waitForViewReady(result, (f) => f.includes('Project 01'));
    result.stdin.write('c');
    await tick();
    expect(routeIds()).toContain('create-project');
  });
});
