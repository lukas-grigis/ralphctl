/**
 * Flow-picker option builders for the enable / disable multi-select prompts. Pure — kept
 * separate from `skills-view.tsx` so the gating rules (what's disabled, what's offered at all)
 * are unit-testable without mounting Ink.
 */

import type { Choice } from '@src/business/interactive/prompt.ts';
import { FLOW_IDS, type FlowId } from '@src/domain/value/flow-id.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';
import { FLOW_LABEL, statusVisual } from '@src/application/ui/tui/views/skills-view-internals/flow-visual.ts';

/**
 * Every flow is offered; a flow the skill is already default-ON for is disabled (opting it in
 * would be a no-op — it loads regardless, see `flowChipVisual`'s doc comment) but still shown so
 * the operator understands why it's greyed out.
 */
export const enableOptions = (entry: SkillCatalogEntry): ReadonlyArray<Choice<FlowId>> =>
  FLOW_IDS.map((flowId) => {
    const isDefault = entry.defaultFor.includes(flowId);
    const install = entry.installs.find((i) => i.flow === flowId);
    return {
      label: FLOW_LABEL[flowId],
      value: flowId,
      disabled: isDefault,
      ...(isDefault
        ? { description: 'already default-on' }
        : install !== undefined
          ? { description: statusVisual(install.status).label }
          : {}),
    };
  });

/** Only the flows currently installed — disabling a flow with no phase-folder copy is a no-op. */
export const disableOptions = (entry: SkillCatalogEntry): ReadonlyArray<Choice<FlowId>> =>
  entry.installs.map((install) => ({
    label: FLOW_LABEL[install.flow],
    value: install.flow,
    description: statusVisual(install.status).label,
  }));
