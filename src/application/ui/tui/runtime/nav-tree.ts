/**
 * Navigation metadata keyed by view id. Typed `Record<ViewId, …>` so registering a view without a label and a section
 * is a compile error.
 */

import type { ViewId } from '@src/application/ui/tui/views/view-registry.tsx';

/** Route-id → display label for the location line. */
export const ROUTE_LABELS: Record<ViewId, string> = {
  home: 'Work',
  flows: 'Flows',
  projects: 'Projects',
  'project-detail': 'Project',
  sprints: 'Sprints',
  'sprint-detail': 'Sprint',
  execute: 'Implement',
  sessions: 'Runs',
  system: 'System',
  settings: 'Settings',
  skills: 'Skills',
  doctor: 'Doctor',
  housekeeping: 'Housekeeping',
  'export-context': 'Export context',
  'export-requirements': 'Export requirements',
  'create-pr': 'Create PR',
  welcome: 'Welcome',
  'create-project': 'New project',
  'add-repository': 'Add repository',
  'add-ticket': 'Add ticket',
};

export type SectionId = 'work' | 'sprints' | 'projects' | 'runs' | 'system';

/** The active section while no section applies (first-run wizard) — the tab bar and location line hide. */
export type ActiveSection = SectionId | 'none';

export interface SectionDef {
  readonly id: SectionId;
  /** The key that jumps to the section (`1`–`5`). */
  readonly digit: string;
  readonly label: string;
  /** The view a fresh stack for this section starts on. */
  readonly rootView: ViewId;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'work', digit: '1', label: 'Work', rootView: 'home' },
  { id: 'sprints', digit: '2', label: 'Sprints', rootView: 'sprints' },
  { id: 'projects', digit: '3', label: 'Projects', rootView: 'projects' },
  { id: 'runs', digit: '4', label: 'Runs', rootView: 'sessions' },
  { id: 'system', digit: '5', label: 'System', rootView: 'system' },
];

const VIEW_SECTION: Record<ViewId, ActiveSection> = {
  home: 'work',
  flows: 'work',
  'add-ticket': 'work',
  'create-pr': 'work',
  'export-context': 'work',
  'export-requirements': 'work',
  sprints: 'sprints',
  'sprint-detail': 'sprints',
  projects: 'projects',
  'project-detail': 'projects',
  'add-repository': 'projects',
  'create-project': 'projects',
  sessions: 'runs',
  execute: 'runs',
  system: 'system',
  settings: 'system',
  skills: 'system',
  doctor: 'system',
  housekeeping: 'system',
  welcome: 'none',
};

/** The section a view belongs to; `'none'` for the first-run wizard. */
export const sectionOf = (viewId: ViewId): ActiveSection => VIEW_SECTION[viewId];

/** Definition lookup — `undefined` for `'none'`. */
export const sectionDef = (id: ActiveSection): SectionDef | undefined => SECTIONS.find((s) => s.id === id);
