/** Human-readable section title per flow id. */
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
 * Derive a human-readable section title from a flow id. Falls back to the raw flowId so a future flow never shows a
 * blank header.
 */
export const flowIdToTitle = (flowId: string): string => FLOW_TITLES[flowId] ?? flowId;

const TITLE_SEPARATOR = ' — ';

/** A run title is `<Flow> — <subject>`; the section stamp already names the flow, so drop that prefix. */
export const titleSubject = (flowId: string, title: string): string => {
  const prefix = `${flowIdToTitle(flowId)}${TITLE_SEPARATOR}`;
  return title.toLowerCase().startsWith(prefix.toLowerCase()) ? title.slice(prefix.length) : title;
};
