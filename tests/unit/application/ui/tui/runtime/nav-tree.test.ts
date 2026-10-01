import { describe, expect, it } from 'vitest';
import { ROUTE_LABELS, SECTIONS, sectionOf } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { VIEW_REGISTRY } from '@src/application/ui/tui/views/view-registry.tsx';

describe('nav-tree ROUTE_LABELS', () => {
  it('labels every registered view and nothing else', () => {
    // The `Record<ViewId, string>` type already fails the build on a missing key; this is the
    // runtime half, which also catches a label left behind for a removed view.
    expect(Object.keys(ROUTE_LABELS).sort()).toEqual(Object.keys(VIEW_REGISTRY).sort());
    for (const [id, label] of Object.entries(ROUTE_LABELS)) expect(label, id).not.toBe('');
  });

  it('names the skills view', () => {
    expect(ROUTE_LABELS.skills).toBe('Skills');
  });
});

describe('nav-tree sections', () => {
  it('lists the five sections with their digits, labels and root views', () => {
    expect(SECTIONS.map((s) => [s.digit, s.label, s.rootView])).toEqual([
      ['1', 'Work', 'home'],
      ['2', 'Sprints', 'sprints'],
      ['3', 'Projects', 'projects'],
      ['4', 'Runs', 'sessions'],
      ['5', 'System', 'system'],
    ]);
  });

  it('assigns every registered view to exactly one section', () => {
    for (const id of Object.keys(VIEW_REGISTRY)) {
      expect(['work', 'sprints', 'projects', 'runs', 'system', 'none'], id).toContain(
        sectionOf(id as keyof typeof VIEW_REGISTRY)
      );
    }
  });

  it.each([
    ['home', 'work'],
    ['flows', 'work'],
    ['add-ticket', 'work'],
    ['create-pr', 'work'],
    ['export-context', 'work'],
    ['export-requirements', 'work'],
    ['sprints', 'sprints'],
    ['sprint-detail', 'sprints'],
    ['projects', 'projects'],
    ['project-detail', 'projects'],
    ['add-repository', 'projects'],
    ['create-project', 'projects'],
    ['sessions', 'runs'],
    ['execute', 'runs'],
    ['system', 'system'],
    ['settings', 'system'],
    ['skills', 'system'],
    ['doctor', 'system'],
    ['welcome', 'none'],
  ] as const)('%s belongs to %s', (view, section) => {
    expect(sectionOf(view)).toBe(section);
  });

  it('labels the section roots Work / Runs / System', () => {
    expect(ROUTE_LABELS.home).toBe('Work');
    expect(ROUTE_LABELS.sessions).toBe('Runs');
    expect(ROUTE_LABELS.system).toBe('System');
  });
});
