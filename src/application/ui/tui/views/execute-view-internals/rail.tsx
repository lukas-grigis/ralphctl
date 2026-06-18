/**
 * Left rail — top-level flow-steps display, two variants:
 *
 *   - `FlowStepsRail`: labelled rail used in the three-column (≥180 cols) and two-column
 *     (140–179 cols) layouts. Width comes from `resolveRailWidth` at three-column (fluid
 *     36→56 at xl+) and the fixed `RAIL_WIDTH` (28) at two-column. The orchestrator computes
 *     the value once per render and passes it in so the truncation budget matches whichever
 *     column actually renders.
 *
 *   - `CompactFlowStepsRail`: glyph-spine variant used at the 100–139 col breakpoint, where
 *     a labelled column would either overflow or steal pixels from the Tasks stream. The
 *     compact `<StepTrace>` drops labels and shrinks to the status glyphs only.
 *
 * Both variants share an `outerFlowFilter` that excludes per-task subchain leaves (any name
 * carrying a uuid suffix) — those render under the Tasks panel — and the `with-repo-lock(…)`
 * plumbing wrapper the operator never needs to see in the plan.
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
  /**
   * Force the meta tail (duration / trailing status label / error message) off regardless of
   * width. The sidebar steps list passes this so a failed step's long error (e.g. a filesystem
   * path) can never wrap across the narrow column — the error already shows in the Recent-log
   * and result footer. When omitted, suppression is derived from `railWidth`.
   */
  readonly suppressMeta?: boolean;
}

// Threshold below which the meta tail (duration / trailing label / error) is suppressed so
// the step name can use the full text budget without being concatenated with status text.
// At ≥32 cols there is room for a short duration like " · 42s" (6 chars) after a truncated name.
const NARROW_RAIL_SUPPRESS_META_THRESHOLD = 32;

export const FlowStepsRail = ({
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

interface CompactRailProps {
  readonly descriptor: SessionDescriptor;
  readonly isRunning: boolean;
  readonly maxRows: number;
}

export const CompactFlowStepsRail = ({ descriptor, isRunning, maxRows }: CompactRailProps): React.JSX.Element => (
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
