const REFINEMENT_MARKER = '<!-- ralphctl:refined-requirements -->';

/**
 * Deterministic comment body posted onto a linked tracker issue after requirements are
 * approved. Identity is the marker line — no sprint id, no timestamp — so a later publish
 * can skip when this exact body is already present.
 */
export const refinementCommentBody = (requirements: string): string => `${requirements}\n\n${REFINEMENT_MARKER}`;
