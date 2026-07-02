/**
 * Pure display-mapping helpers for the Skills catalog view. Kept separate from `skills-view.tsx`
 * so the glyph/colour/label decisions are unit-testable without mounting Ink.
 */

import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { SkillCatalogEntry, SkillInstallStatus } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';

/** Full flow name — used in picker option labels. */
export const FLOW_LABEL: Record<FlowId, string> = {
  refine: 'Refine',
  plan: 'Plan',
  implement: 'Implement',
  readiness: 'Readiness',
  ideate: 'Ideate',
  createPr: 'Create PR',
};

/** Three-letter abbreviation — used in the compact per-row flow-chip strip. */
export const FLOW_ABBR: Record<FlowId, string> = {
  refine: 'ref',
  plan: 'pln',
  implement: 'imp',
  readiness: 'rdy',
  ideate: 'ide',
  createPr: 'pr ',
};

export interface FlowChipVisual {
  readonly glyph: string;
  readonly color: string;
  readonly bold: boolean;
  /** One-word state description reused by both the row chip and the enable/disable picker. */
  readonly label: string;
}

/** Glyph/colour/label for one {@link SkillInstallStatus}. */
export const statusVisual = (status: SkillInstallStatus): FlowChipVisual => {
  switch (status) {
    case 'in-sync':
      return { glyph: glyphs.check, color: inkColors.success, bold: false, label: 'in sync' };
    case 'update-available':
      return { glyph: glyphs.warningGlyph, color: inkColors.warning, bold: false, label: 'update available' };
    case 'locally-modified':
      return { glyph: glyphs.modified, color: inkColors.error, bold: false, label: 'locally modified' };
    case 'manual':
      return { glyph: glyphs.infoGlyph, color: inkColors.muted, bold: false, label: 'manual' };
  }
};

/**
 * Resolve one flow's chip glyph/colour/label for a catalog entry row. `defaultFor` always wins
 * over any install status — a default-on skill loads regardless of a phase-folder copy (see the
 * registry's module doc), so the display must say so even when a redundant opt-in copy exists
 * (decision: overlap is tolerated, never hidden).
 */
export const flowChipVisual = (flowId: FlowId, entry: SkillCatalogEntry): FlowChipVisual => {
  if (entry.defaultFor.includes(flowId)) {
    return { glyph: glyphs.phaseDone, color: inkColors.highlight, bold: true, label: 'always on (default)' };
  }
  const install = entry.installs.find((i) => i.flow === flowId);
  if (install === undefined) {
    return { glyph: glyphs.phaseDisabled, color: inkColors.muted, bold: false, label: 'not enabled' };
  }
  return statusVisual(install.status);
};
