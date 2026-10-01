/**
 * State-machine visibility helper for the Flows menu. Pure — given the current sprint state, returns the set of flow
 * ids that should be visible.
 */

import type { SprintStatus } from '@src/domain/entity/sprint.ts';

/** Flow id surfaced in both the sprint-scoped list and several per-status allow-lists. */
const REMOVE_TICKET = 'remove-ticket';

/** Ticket-append flow. */
const ADD_TICKET = 'add-ticket';

/** Sprint-scoped flow ids — only meaningful when a sprint is selected. */
export const SPRINT_SCOPED_FLOW_IDS: readonly string[] = [
  'refine',
  'plan',
  'implement',
  'review',
  'close-sprint',
  'create-pr',
  ADD_TICKET,
  REMOVE_TICKET,
];

/** Project-scoped flow ids — meaningful anytime a project is loaded. */
export const PROJECT_SCOPED_FLOW_IDS: readonly string[] = [
  'create-sprint',
  'readiness',
  'detect-scripts',
  'detect-skills',
  'export-context',
  'export-requirements',
];

/** Flows hidden from the default menu but reachable via the `v` (show-all) toggle. */
export const HIDDEN_BY_DEFAULT_FLOW_IDS: readonly string[] = ['ideate'];

const SPRINT_SCOPED_SET: ReadonlySet<string> = new Set(SPRINT_SCOPED_FLOW_IDS);
const PROJECT_SCOPED_SET: ReadonlySet<string> = new Set(PROJECT_SCOPED_FLOW_IDS);
const HIDDEN_SET: ReadonlySet<string> = new Set(HIDDEN_BY_DEFAULT_FLOW_IDS);

/** Per-sprint-status allow-list. */
const ALLOWED_BY_STATUS: Readonly<Record<SprintStatus, ReadonlySet<string>>> = {
  draft: new Set(['refine', 'plan', ADD_TICKET, REMOVE_TICKET]),
  planned: new Set(['implement']),
  active: new Set(['implement']),
  review: new Set(['review', 'close-sprint', 'create-pr']),
  done: new Set(['create-pr']),
};

export interface VisibilityInput {
  readonly hasProject: boolean;
  readonly sprintStatus?: SprintStatus;
  readonly showAll: boolean;
}

/** Compute the visible-flow id set for the current selection. */
export const visibleFlowsFor = (input: VisibilityInput): ReadonlySet<string> => {
  if (input.showAll) {
    return new Set([...PROJECT_SCOPED_FLOW_IDS, ...SPRINT_SCOPED_FLOW_IDS, ...HIDDEN_BY_DEFAULT_FLOW_IDS]);
  }

  const visible = new Set<string>();
  if (input.hasProject) {
    for (const id of PROJECT_SCOPED_FLOW_IDS) visible.add(id);
  }
  if (input.sprintStatus !== undefined) {
    const allow = ALLOWED_BY_STATUS[input.sprintStatus];
    if (allow !== undefined) {
      for (const id of allow) visible.add(id);
    }
  }
  return visible;
};

/** Section label for a flow id — drives the menu's group headers. */
export const sectionFor = (flowId: string): string => {
  if (PROJECT_SCOPED_SET.has(flowId)) return 'project';
  if (SPRINT_SCOPED_SET.has(flowId)) return 'sprint';
  if (HIDDEN_SET.has(flowId)) return 'project';
  return 'more';
};

/** Section render order. Sprint-scoped section leads when a sprint is in context. */
export const SECTION_ORDER: readonly string[] = ['sprint', 'project', 'more'];

export const sectionRank = (section: string): number => {
  const idx = SECTION_ORDER.indexOf(section);
  return idx === -1 ? SECTION_ORDER.length : idx;
};
