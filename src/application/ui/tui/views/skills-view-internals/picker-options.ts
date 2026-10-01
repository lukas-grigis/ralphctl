/** Flow-picker option builders for the enable / disable multi-select prompts. */

import type { Choice } from '@src/business/interactive/prompt.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import {
  FLOW_LABEL,
  SKILL_MOUNTING_FLOW_IDS,
  statusVisual,
} from '@src/application/ui/tui/views/skills-view-internals/flow-visual.ts';

/**
 * Every skill-MOUNTING flow is offered. Flows the skill is already default-ON for, and edit-protected copies, are shown
 * but disabled, so the operator sees why they're greyed out.
 */
export const enableOptions = (entry: SkillCatalogEntry): ReadonlyArray<Choice<FlowId>> =>
  SKILL_MOUNTING_FLOW_IDS.map((flowId) => {
    const isDefault = entry.defaultFor.includes(flowId);
    const install = entry.installs.find((i) => i.flow === flowId);
    const editProtected = install?.status === 'locally-modified' || install?.status === 'manual';
    return {
      label: FLOW_LABEL[flowId],
      value: flowId,
      disabled: isDefault || editProtected,
      ...(isDefault
        ? { description: 'already default-on' }
        : editProtected
          ? { description: `${statusVisual(install.status).label} — u overwrites` }
          : install !== undefined
            ? { description: statusVisual(install.status).label }
            : {}),
    };
  });

/**
 * Preselection for the enable picker: `recommendedFor`, narrowed to rows that are actually selectable (mounting
 * flows, not default-on, not edit-protected).
 */
export const enablePreselect = (entry: SkillCatalogEntry): readonly FlowId[] => {
  const selectable = new Set(
    enableOptions(entry)
      .filter((o) => o.disabled !== true)
      .map((o) => o.value)
  );
  return entry.recommendedFor.filter((f) => selectable.has(f));
};

/** Only the flows currently installed — disabling a flow with no phase-folder copy is a no-op. */
export const disableOptions = (entry: SkillCatalogEntry): ReadonlyArray<Choice<FlowId>> =>
  entry.installs.map((install) => ({
    label: FLOW_LABEL[install.flow],
    value: install.flow,
    description: statusVisual(install.status).label,
  }));
