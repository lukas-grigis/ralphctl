/**
 * Shared types + helpers for the execute-view task surfaces.
 *
 * `TaskGridItem` duck-types the fields the list and graph renderers need
 * from the runner's chain context — kept here so both renderers and the
 * orchestrator (`task-execution-grid.tsx`) can import it without forming
 * a cycle.
 */

import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';

export interface TaskGridItem {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
  readonly projectPath: string;
  readonly blockedReason?: string | undefined;
}

/**
 * Derive a short human-readable activity string from the most recent signal
 * emitted for a task. Returns `''` for variants that aren't interesting to
 * display (the caller treats empty as "no activity line").
 */
export function activityFromSignal(signal: HarnessSignal): string {
  switch (signal.type) {
    case 'progress':
      return signal.summary.slice(0, 100);
    case 'note':
      return `note: ${signal.text.slice(0, 90)}`;
    case 'task-verified':
      return `verified: ${signal.output.slice(0, 80)}`;
    case 'task-complete':
      return 'task complete';
    case 'task-blocked':
      return `blocked: ${signal.reason.slice(0, 90)}`;
    case 'evaluation':
      return `evaluation: ${signal.status}`;
    case 'check-script-discovery':
    case 'agents-md-proposal':
    case 'setup-script':
    case 'verify-script':
    case 'skill-suggestions':
      return '';
  }
}
