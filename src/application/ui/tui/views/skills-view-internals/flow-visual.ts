/**
 * Pure display-mapping helpers for the Skills catalog view. Kept separate from `skills-view.tsx`
 * so the glyph/colour/label decisions are unit-testable without mounting Ink.
 */

import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import type { SkillCatalogEntry, SkillInstallStatus } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { PHASE_FLOW_DIR } from '@src/integration/ai/skills/phase/source.ts';
import { flowMountsSkills } from '@src/application/ui/shared/launcher.ts';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';

/**
 * Flows whose launch context actually mounts a skill source — derived from the launcher's
 * `flowMountsSkills` (the single source of truth), keyed back to `FlowId` via the phase-dir
 * mapping (dir names equal the orchestration dispatch ids). The catalog offers, preselects, and
 * renders chips ONLY for these: advertising an enable target no launch ever consumes (createPr
 * today — its flow has no skill-mounting dispatch) would misrepresent effect.
 */
export const SKILL_MOUNTING_FLOW_IDS: readonly FlowId[] = FLOW_IDS.filter((flowId) =>
  flowMountsSkills(PHASE_FLOW_DIR[flowId])
);

/**
 * Flows a row renders chips for: every mounting flow, plus any NON-mounting flow that already
 * holds an install (a leftover copy must stay visible so it can be disabled — it renders as
 * `inactive`, never as a live status).
 */
export const chipFlowsFor = (entry: SkillCatalogEntry): readonly FlowId[] => {
  const mounting = new Set(SKILL_MOUNTING_FLOW_IDS);
  const leftovers = entry.installs.map((i) => i.flow).filter((f) => !mounting.has(f));
  return [...SKILL_MOUNTING_FLOW_IDS, ...leftovers];
};

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
    case 'broken':
      return { glyph: glyphs.cross, color: inkColors.error, bold: false, label: 'broken (no SKILL.md)' };
  }
};

/**
 * Resolve one flow's chip glyph/colour/label for a catalog entry row. `defaultFor` wins over any
 * install status — a default-on skill loads regardless of a phase-folder copy (see the registry's
 * module doc), so the display must say so even when a redundant opt-in copy exists (decision:
 * overlap is tolerated, never hidden) — UNLESS the flow's saved `settings.ai.skills` row durably
 * opts the skill out, in which case the chip must not claim "always on". A leftover install on a
 * non-mounting flow renders `inactive` — that flow loads no skills at all.
 */
export const flowChipVisual = (
  flowId: FlowId,
  entry: SkillCatalogEntry,
  savedDisabled?: (flowId: FlowId) => ReadonlySet<string>
): FlowChipVisual => {
  if (!SKILL_MOUNTING_FLOW_IDS.includes(flowId)) {
    return {
      glyph: glyphs.phaseDisabled,
      color: inkColors.muted,
      bold: false,
      label: 'inactive (flow loads no skills)',
    };
  }
  if (entry.defaultFor.includes(flowId)) {
    if (savedDisabled?.(flowId).has(entry.name) === true) {
      return { glyph: glyphs.phaseDisabled, color: inkColors.muted, bold: false, label: 'default, off (saved)' };
    }
    return { glyph: glyphs.phaseDone, color: inkColors.highlight, bold: true, label: 'always on (default)' };
  }
  const install = entry.installs.find((i) => i.flow === flowId);
  if (install === undefined) {
    return { glyph: glyphs.phaseDisabled, color: inkColors.muted, bold: false, label: 'not enabled' };
  }
  return statusVisual(install.status);
};
