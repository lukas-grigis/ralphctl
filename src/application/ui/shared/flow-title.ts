/**
 * Human-readable section title per flow id. Keeps the Execute view header accurate for any
 * flow that reuses this view (refine, plan, review, create-pr, …) instead of always showing
 * "Implement".
 */
const FLOW_TITLES: Record<string, string> = {
  implement: 'Implement',
  refine: 'Refine',
  plan: 'Plan',
  ideate: 'Ideate',
  review: 'Review',
  'create-pr': 'Create PR',
  readiness: 'Readiness',
  'detect-scripts': 'Detect Scripts',
  'detect-skills': 'Detect Skills',
  'create-sprint': 'Create Sprint',
  'close-sprint': 'Close Sprint',
  'add-ticket': 'Add Ticket',
  'remove-ticket': 'Remove Ticket',
  'export-context': 'Export Context',
  'export-requirements': 'Export Requirements',
  doctor: 'Doctor',
  settings: 'Settings',
};

/**
 * Derive a human-readable section title from a flow id. Falls back to the raw flowId so a
 * future flow never shows a blank header.
 */
export const flowIdToTitle = (flowId: string): string => FLOW_TITLES[flowId] ?? flowId;
