/**
 * Maps view ids to their component. `ViewId` is derived from this table's keys, so registering a
 * new view here is the one edit that makes it a valid `ViewEntry.id` everywhere the id is
 * type-checked — the router, launch routing, the home menu builder, and the global keyboard
 * shortcuts all consume this same union. `App` reads `router.current.id` and renders the
 * matching entry; an id that somehow isn't registered at runtime (e.g. a stale persisted route)
 * falls through to the registry-level fallback.
 */

import React from 'react';
import { UnknownViewFallback, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import { FlowsView } from '@src/application/ui/tui/views/flows-view.tsx';
import { ProjectsView } from '@src/application/ui/tui/views/projects-view.tsx';
import { ProjectDetailView } from '@src/application/ui/tui/views/project-detail-view.tsx';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import { SessionsView } from '@src/application/ui/tui/views/sessions-view.tsx';
import { SettingsView } from '@src/application/ui/tui/views/settings-view.tsx';
import { SkillsView } from '@src/application/ui/tui/views/skills-view.tsx';
import { DoctorView } from '@src/application/ui/tui/views/doctor-view.tsx';
import { ExportContextView } from '@src/application/ui/tui/views/export-context-view.tsx';
import { ExportRequirementsView } from '@src/application/ui/tui/views/export-requirements-view.tsx';
import { CreatePrView } from '@src/application/ui/tui/views/create-pr-view.tsx';
import { WelcomeView } from '@src/application/ui/tui/views/welcome-view.tsx';
import { CreateProjectView } from '@src/application/ui/tui/views/create-project-view.tsx';
import { AddRepositoryView } from '@src/application/ui/tui/views/add-repository-view.tsx';
import { AddTicketView } from '@src/application/ui/tui/views/add-ticket-view.tsx';
import { PickProjectView } from '@src/application/ui/tui/views/pick-project-view.tsx';
import { PickSprintView } from '@src/application/ui/tui/views/pick-sprint-view.tsx';

/**
 * The single source of truth for every navigable view. `satisfies` (rather than annotating this
 * with `Record<ViewId, …>`) is what lets `ViewId` be derived from the table's own keys below —
 * the annotation would otherwise have to name the type it's defining.
 */
const VIEW_REGISTRY = {
  home: HomeView,
  flows: FlowsView,
  projects: ProjectsView,
  'project-detail': ProjectDetailView,
  sprints: SprintsView,
  'sprint-detail': SprintDetailView,
  execute: ExecuteView,
  sessions: SessionsView,
  settings: SettingsView,
  skills: SkillsView,
  doctor: DoctorView,
  'export-context': ExportContextView,
  'export-requirements': ExportRequirementsView,
  'create-pr': CreatePrView,
  welcome: WelcomeView,
  'create-project': CreateProjectView,
  'add-repository': AddRepositoryView,
  'add-ticket': AddTicketView,
  'pick-project': PickProjectView,
  'pick-sprint': PickSprintView,
} as const satisfies Record<string, React.ComponentType>;

/** Every valid destination for a `ViewEntry.id` — add a view by appending one entry above. */
export type ViewId = keyof typeof VIEW_REGISTRY;

export const renderView = (entry: ViewEntry): React.JSX.Element => {
  // `ViewId` guarantees every literal in the tree is registered at compile time, but a runtime id
  // can still miss the table (a persisted route from a since-removed view) — index through a
  // widened view so the miss falls through to the fallback instead of `undefined` blowing up.
  const Component = (VIEW_REGISTRY as Record<string, React.ComponentType | undefined>)[entry.id];
  if (Component === undefined) return <UnknownViewFallback id={entry.id} />;
  return <Component />;
};
