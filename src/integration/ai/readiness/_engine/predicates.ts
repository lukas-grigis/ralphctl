import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { ClaudeArtifacts } from '@src/integration/ai/readiness/claude/artifacts.ts';
import type { CopilotArtifacts } from '@src/integration/ai/readiness/copilot/artifacts.ts';

/** Narrow {@link ReadinessState} to its `present` variant. */
export const isPresent = (state: ReadinessState): state is Extract<ReadinessState, { kind: 'present' }> =>
  state.kind === 'present';

export const isAbsent = (state: ReadinessState): state is Extract<ReadinessState, { kind: 'absent' }> =>
  state.kind === 'absent';

export const isUnknown = (state: ReadinessState): state is Extract<ReadinessState, { kind: 'unknown' }> =>
  state.kind === 'unknown';

/**
 * True iff at least one Claude-specific artifact has been discovered. Trivially false on an
 * empty `ClaudeArtifacts` (only collections present, all empty).
 */
export const hasAnyClaudeArtifact = (a: ClaudeArtifacts): boolean =>
  a.claudeMd !== undefined ||
  a.agentsMd !== undefined ||
  a.settings !== undefined ||
  a.settingsLocal !== undefined ||
  a.mcpConfig !== undefined ||
  a.skills.length > 0 ||
  a.commands.length > 0 ||
  a.agents.length > 0 ||
  a.hooks.length > 0;

export const hasAnyCopilotArtifact = (a: CopilotArtifacts): boolean => a.copilotInstructions !== undefined;
