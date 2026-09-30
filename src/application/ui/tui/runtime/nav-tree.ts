/**
 * Navigation metadata keyed by view id. Typed `Record<ViewId, string>` so registering a view
 * without a label is a compile error.
 */

import type { ViewId } from '@src/application/ui/tui/views/view-registry.tsx';

/** Route-id → display label for the breadcrumb path. */
export const ROUTE_LABELS: Record<ViewId, string> = {
  home: 'Home',
  flows: 'Flows',
  projects: 'Projects',
  'project-detail': 'Project',
  sprints: 'Sprints',
  'sprint-detail': 'Sprint',
  execute: 'Implement',
  sessions: 'Sessions',
  settings: 'Settings',
  skills: 'Skills',
  doctor: 'Doctor',
  'export-context': 'Export context',
  'export-requirements': 'Export requirements',
  'create-pr': 'Create PR',
  welcome: 'Welcome',
  'create-project': 'New project',
  'add-repository': 'Add repository',
  'add-ticket': 'Add ticket',
  'pick-project': 'Pick project',
  'pick-sprint': 'Pick sprint',
};
