/**
 * Left rail — top-level flow-steps display, two variants: - `FlowStepsRail`: labelled rail used in the three-column
 * (≥180 cols) and two-column (140–179 cols) layouts.
 */

import React from 'react';
import { StepTrace } from '@src/application/ui/tui/components/step-trace.tsx';
import { isPerTaskLeaf } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';

export const outerFlowFilter = (name: string): boolean => !isPerTaskLeaf(name) && !name.startsWith('with-repo-lock(');

interface RailProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly maxRows: number;
  readonly railWidth: number;
  /** Force the meta tail (duration / trailing status label / error message) off regardless of width. */
  readonly suppressMeta?: boolean;
}

// Threshold below which the meta tail (duration / trailing label / error) is suppressed so the step name can use the
// full text budget without being concatenated with status text.
const NARROW_RAIL_SUPPRESS_META_THRESHOLD = 32;

const FlowStepsRailImpl = ({
  descriptor,
  isRunning,
  maxRows,
  railWidth,
  suppressMeta,
}: RailProps): React.JSX.Element => (
  <StepTrace
    trace={descriptor.trace}
    running={isRunning}
    filter={outerFlowFilter}
    maxRows={maxRows}
    railWidth={railWidth}
    suppressMeta={suppressMeta ?? railWidth < NARROW_RAIL_SUPPRESS_META_THRESHOLD}
    {...(descriptor.plannedLeaves !== undefined ? { plan: descriptor.plannedLeaves } : {})}
    {...(descriptor.planLabelByName !== undefined ? { labelByName: descriptor.planLabelByName } : {})}
    {...(isRunning && descriptor.plannedLeaves === undefined ? { inFlightLabel: 'awaiting next step…' } : {})}
  />
);

// Memoized: none of this component's props are driven by the Execute view's 1 Hz clock — only
// re-renders (and re-formats the trace list) when the descriptor's trace / plan actually change.
export const FlowStepsRail = React.memo(FlowStepsRailImpl);

interface CompactRailProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly maxRows: number;
}

const CompactFlowStepsRailImpl = ({ descriptor, isRunning, maxRows }: CompactRailProps): React.JSX.Element => (
  // `inFlightLabel` is intentionally dropped here — at the compact breakpoint there is no
  // room for any text anyway, so the rail's job is just "is the runner moving and which
  // phase is it on".
  <StepTrace
    trace={descriptor.trace}
    running={isRunning}
    filter={outerFlowFilter}
    maxRows={maxRows}
    compact
    {...(descriptor.plannedLeaves !== undefined ? { plan: descriptor.plannedLeaves } : {})}
    {...(descriptor.planLabelByName !== undefined ? { labelByName: descriptor.planLabelByName } : {})}
  />
);

export const CompactFlowStepsRail = React.memo(CompactFlowStepsRailImpl);
