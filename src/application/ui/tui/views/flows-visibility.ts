/**
 * State-machine visibility helper for the Flows menu. Pure — given the current sprint state,
 * returns the set of flow ids that should be visible.
 *
 * Sprint-scoped flows are gated by `sprint.status`:
 *  - `draft`   → refine, add-tickets, plan, ticket-remove
 *  - `planned` → implement, ticket-remove
 *  - `active`  → implement
 *  - `review`  → review, close-sprint
 *  - `done`    → create-pr
 *
 * Project-scoped flows (create-sprint, ideate, readiness, detect-scripts, detect-skills,
 * export-*, doctor, settings) are unconditional and always returned.
 *
 * `showAll: true` overrides every state-machine gate and returns the union of every known
 * flow — the menu still dims disabled ones via `evaluateTriggers`, but at least the
 * inapplicable rows are visible for discovery / context.
 *
 * Unknown sprint states fall through to "no sprint-scoped flows" so the helper degrades
 * gracefully if the domain adds a new state without updating this file.
 */

import type { SprintStatus } from '@src/domain/entity/sprint.ts';

/** Sprint-scoped flow ids — only meaningful when a sprint is selected. */
export const SPRINT_SCOPED_FLOW_IDS: readonly string[] = [
  'refine',
  'add-tickets',
  'plan',
  'implement',
  'review',
  'close-sprint',
  'create-pr',
  'ticket-remove',
];

/**
 * Project-scoped flow ids — meaningful anytime a project is loaded.
 *
 * `doctor` and `settings` are intentionally absent: they aren't flows (no chain, no state
 * transition) and they already have global Home shortcuts (`!` and `s`). Surfacing them here
 * pollutes the "pick a flow" mental model.
 */
export const PROJECT_SCOPED_FLOW_IDS: readonly string[] = [
  'create-sprint',
  'readiness',
  'detect-scripts',
  'detect-skills',
  'export-context',
  'export-requirements',
];

/**
 * Flows hidden from the default menu but reachable via the `v` (show-all) toggle. Use for
 * flows we want to deprecate progressively — keep the code path alive while removing the
 * default affordance. Currently: `ideate` (one-shot combo of refine + plan; the separated
 * pair gives better state-machine visibility and a HITL checkpoint between requirements and
 * tasks, so we hide ideate by default).
 */
export const HIDDEN_BY_DEFAULT_FLOW_IDS: readonly string[] = ['ideate'];

const SPRINT_SCOPED_SET: ReadonlySet<string> = new Set(SPRINT_SCOPED_FLOW_IDS);
const PROJECT_SCOPED_SET: ReadonlySet<string> = new Set(PROJECT_SCOPED_FLOW_IDS);
const HIDDEN_SET: ReadonlySet<string> = new Set(HIDDEN_BY_DEFAULT_FLOW_IDS);

/**
 * Per-sprint-status allow-list. Each entry is the set of sprint-scoped flow ids that should
 * surface to the user in that state; everything else is hidden by default (or dimmed when
 * `showAll` is on).
 */
const ALLOWED_BY_STATUS: Readonly<Record<SprintStatus, ReadonlySet<string>>> = {
  draft: new Set(['refine', 'add-tickets', 'plan', 'ticket-remove']),
  planned: new Set(['implement', 'ticket-remove']),
  active: new Set(['implement']),
  review: new Set(['review', 'close-sprint']),
  done: new Set(['create-pr']),
};

export interface VisibilityInput {
  readonly hasProject: boolean;
  readonly sprintStatus?: SprintStatus;
  readonly showAll: boolean;
}

/**
 * Compute the visible-flow id set for the current selection. Project-scoped flows are
 * unconditionally visible when a project is loaded; sprint-scoped flows are visible only
 * when (1) a sprint is selected AND (2) the current status's allow-list includes them.
 * `showAll` bypasses both gates so the menu shows every known flow with dim styling.
 */
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
