/** Launcher-flow → AI settings-row mapping and row merging, shared by the launcher and its per-flow launch modules. */

import type { AiFlowSettings, AiProvider } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

/** Launcher flow id → the AI settings row that owns its session, or `undefined` for flows that don't open one. */
export const aiFlowIdFor = (flowId: string): FlowId | undefined => {
  switch (flowId) {
    case 'refine':
    case 'plan':
    case 'implement':
    case 'readiness':
    case 'ideate':
      return flowId;
    case 'detect-scripts':
    case 'detect-skills':
      return 'readiness';
    case 'review':
      return 'implement';
    case 'create-pr':
      // The kebab-case orchestration id maps to its camelCase settings row.
      return 'createPr';
    default:
      return undefined;
  }
};

/** Per-launch partial override of one AI row; an unset field keeps the persisted value. */
interface FlowRowOverride {
  readonly provider?: AiProvider;
  readonly model?: string;
  readonly effort?: string;
}

/** Per-field merge of `override` onto an `AiFlowSettings` row. */
export const mergeFlowRow = (base: AiFlowSettings, override: FlowRowOverride): AiFlowSettings => {
  const provider = override.provider ?? base.provider;
  const model = override.model ?? base.model;
  const effort = override.effort ?? base.effort;
  return { provider, model, ...(effort !== undefined ? { effort } : {}) } as AiFlowSettings;
};
