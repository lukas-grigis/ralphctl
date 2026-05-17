/**
 * Maps view ids to their component. The `App` reads `router.current.id` and renders the
 * matching entry; unknown ids fall through to the registry-level fallback.
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

export const renderView = (entry: ViewEntry): React.JSX.Element => {
  switch (entry.id) {
    case 'home':
      return <HomeView />;
    case 'flows':
      return <FlowsView />;
    case 'projects':
      return <ProjectsView />;
    case 'project-detail':
      return <ProjectDetailView />;
    case 'sprints':
      return <SprintsView />;
    case 'sprint-detail':
      return <SprintDetailView />;
    case 'execute':
      return <ExecuteView />;
    case 'sessions':
      return <SessionsView />;
    case 'settings':
      return <SettingsView />;
    case 'doctor':
      return <DoctorView />;
    case 'export-context':
      return <ExportContextView />;
    case 'export-requirements':
      return <ExportRequirementsView />;
    case 'create-pr':
      return <CreatePrView />;
    case 'welcome':
      return <WelcomeView />;
    case 'create-project':
      return <CreateProjectView />;
    case 'add-repository':
      return <AddRepositoryView />;
    case 'add-ticket':
      return <AddTicketView />;
    case 'pick-project':
      return <PickProjectView />;
    case 'pick-sprint':
      return <PickSprintView />;
    default:
      return <UnknownViewFallback id={entry.id} />;
  }
};
