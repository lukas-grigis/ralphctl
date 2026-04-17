/**
 * PipelineMap — the visual spine of Home.
 *
 * Renders a 4-row pipeline (Refine / Plan / Execute / Close) with per-phase
 * status + detail text, vertical connectors between phases, and a bright
 * "Next" quick-action row anchored above that pre-selects whatever the
 * current phase's primary action is. Arrow keys cycle through every row
 * so the user can scan the map freely.
 *
 * Two user intents, two callbacks:
 *   - "Just do the next right thing" → Enter on the quick-action row fires
 *     `onAction(action)` which dispatches the matching command.
 *   - "Show me the details for this phase" → Enter on a phase row fires
 *     `onDrillIn(phaseId)` which the parent turns into a router push.
 *
 * The initial cursor lands on the quick-action row when one exists — that
 * way a bare Enter immediately does the right thing.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';
import type { Phase, PhaseAction, PhaseId, PipelineSnapshot } from '@src/integration/ui/tui/views/pipeline-phases.ts';

interface Props {
  readonly snapshot: PipelineSnapshot;
  readonly onAction: (action: PhaseAction) => void;
  readonly onDrillIn: (phaseId: PhaseId) => void;
  readonly disabled?: boolean;
}

type Row = { kind: 'quick'; action: PhaseAction } | { kind: 'phase'; phase: Phase; index: number; isLast: boolean };

function buildRows(snapshot: PipelineSnapshot): Row[] {
  const rows: Row[] = [];
  if (snapshot.nextStep !== null) {
    rows.push({ kind: 'quick', action: snapshot.nextStep });
  }
  snapshot.phases.forEach((phase, i) => {
    rows.push({
      kind: 'phase',
      phase,
      index: i + 1,
      isLast: i === snapshot.phases.length - 1,
    });
  });
  return rows;
}

function nextCursor(rows: Row[], from: number, direction: 1 | -1): number {
  const n = rows.length;
  if (n === 0) return 0;
  return (from + direction + n) % n;
}

function findInitialCursor(rows: Row[]): number {
  const quick = rows.findIndex((r) => r.kind === 'quick');
  return quick >= 0 ? quick : 0;
}

const STATUS_GLYPH: Record<Phase['status'], string> = {
  done: glyphs.phaseDone,
  active: glyphs.phaseActive,
  pending: glyphs.phasePending,
};

const STATUS_COLOR: Record<Phase['status'], string> = {
  done: inkColors.success,
  active: inkColors.warning,
  pending: inkColors.muted,
};

export function PipelineMap({ snapshot, onAction, onDrillIn, disabled = false }: Props): React.JSX.Element {
  const rows = useMemo(() => buildRows(snapshot), [snapshot]);
  const [cursor, setCursor] = useState(() => findInitialCursor(rows));

  useEffect(() => {
    setCursor(findInitialCursor(rows));
  }, [rows]);

  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setCursor((c) => nextCursor(rows, c, -1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => nextCursor(rows, c, 1));
        return;
      }
      if (key.return) {
        const row = rows[cursor];
        if (!row) return;
        if (row.kind === 'quick') {
          onAction(row.action);
        } else {
          onDrillIn(row.phase.id);
        }
      }
    },
    { isActive: !disabled }
  );

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const selected = !disabled && i === cursor;
        if (row.kind === 'quick') {
          return (
            <Box key="quick" marginBottom={spacing.section}>
              <Text color={selected ? inkColors.highlight : inkColors.info} bold>
                {selected ? glyphs.actionCursor : ' '} Next: {row.action.label}
              </Text>
            </Box>
          );
        }
        const p = row.phase;
        const glyph = STATUS_GLYPH[p.status];
        const glyphColor = STATUS_COLOR[p.status];
        const titleColor = selected ? inkColors.highlight : undefined;
        return (
          <Box key={p.id} flexDirection="column">
            <Box>
              <Text color={selected ? inkColors.highlight : undefined} bold={selected}>
                {selected ? glyphs.actionCursor : ' '}
              </Text>
              <Text color={glyphColor} bold>
                {` ${glyph}`}
              </Text>
              <Text>{`  ${String(row.index)}. `}</Text>
              <Text color={titleColor} bold={selected}>
                {p.title.padEnd(9)}
              </Text>
              <Text dimColor>{`  ${p.detail}`}</Text>
              {selected ? <Text color={inkColors.info} dimColor>{`  ${glyphs.inlineDot} Enter to open`}</Text> : null}
            </Box>
            {!row.isLast ? (
              <Box>
                <Text>{'  '}</Text>
                <Text color={inkColors.muted} dimColor>
                  {glyphs.separatorVertical}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
