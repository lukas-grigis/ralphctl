import { describe, expect, it } from 'vitest';
import { renderSprintContextMarkdown } from '@src/business/sprint/views/context-md.ts';
import { makeApprovedTicket, makeDraftSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

describe('renderSprintContextMarkdown', () => {
  it('renders sprint header, project section, tickets, tasks', () => {
    const project = makeProject();
    const ticket = makeApprovedTicket({ title: 'login bug' });
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const task = makeTodoTask({ name: 'wire form' });
    const out = renderSprintContextMarkdown({ sprint, project, tasks: [task] });
    expect(out).toContain(`# Harness Context — ${sprint.name}`);
    expect(out).toContain(`### ${project.displayName}`);
    expect(out).toContain('## Tickets');
    expect(out).toContain('### login bug');
    expect(out).toContain('## Tasks');
    expect(out).toContain('### 1. wire form');
  });

  it('shows empty-state hints when there are no tickets / tasks', () => {
    const project = makeProject();
    const sprint = makeDraftSprint();
    const out = renderSprintContextMarkdown({ sprint, project, tasks: [] });
    expect(out).toContain('_(no tickets)_');
    expect(out).toContain('_(no tasks generated yet — run `ralphctl sprint plan`)_');
  });

  it('orders tasks by `order` ascending regardless of input order', () => {
    const project = makeProject();
    const sprint = makeDraftSprint();
    const t1 = makeTodoTask({ name: 'first', order: 1 });
    const t3 = makeTodoTask({ name: 'third', order: 3 });
    const t2 = makeTodoTask({ name: 'second', order: 2 });
    const out = renderSprintContextMarkdown({ sprint, project, tasks: [t3, t1, t2] });
    const idxFirst = out.indexOf('### 1. first');
    const idxSecond = out.indexOf('### 2. second');
    const idxThird = out.indexOf('### 3. third');
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(idxThird).toBeGreaterThan(idxSecond);
  });

  it('includes only the supplied project (not a registry list)', () => {
    const project = makeProject({ displayName: 'Only One' });
    const sprint = makeDraftSprint();
    const out = renderSprintContextMarkdown({ sprint, project, tasks: [] });
    expect(out).toContain('### Only One');
    // No "Projects" section heading variants from v1's multi-project export.
    expect(out).not.toMatch(/^## Projects$/m);
  });
});
