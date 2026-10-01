/**
 * Housekeeping — dry-run preview of reclaimable data (orphan sprints and memory, old done sprints
 * and runs) with sizes. `space` marks candidates, `↵` deletes the marked ones after a confirm;
 * nothing is removed before that. The scan and the purge are the use cases behind `deps.housekeeping`.
 */

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { AsyncListFrame } from '@src/application/ui/tui/components/async-list-frame.tsx';
import { ConfirmCard } from '@src/application/ui/tui/components/confirm-card.tsx';
import { EmptyState } from '@src/application/ui/tui/components/empty-state.tsx';
import { FeedbackLine, feedback, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import {
  OverflowRow,
  useListWindow,
  type UseListWindowResult,
} from '@src/application/ui/tui/components/windowed-list.tsx';
import { plural } from '@src/application/ui/shared/plural.ts';
import { formatBytes } from '@src/application/ui/shared/format-bytes.ts';
import { glyphs, inkColors, listCapacity, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useIsMounted } from '@src/application/ui/tui/runtime/use-is-mounted.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import {
  buildHousekeepingRows,
  GROUP_LABELS,
  groupCounts,
  selectionTotals,
  type HousekeepingRow,
} from '@src/application/ui/tui/views/housekeeping-rows.ts';
import type { HousekeepingScan } from '@src/business/housekeeping/scan-housekeeping.ts';
import type { HousekeepingPurgeReport } from '@src/business/housekeeping/purge-housekeeping.ts';

/** Rows outside the list: chrome (3), footer (2), summary (2), selection line (2), feedback. */
const CHROME_ROWS = 11;
const GROUP_WIDTH = 17;
const SIZE_WIDTH = 9;

const Row = ({
  row,
  focused,
  checked,
  firstOfGroup,
}: {
  readonly row: HousekeepingRow;
  readonly focused: boolean;
  readonly checked: boolean;
  readonly firstOfGroup: boolean;
}): React.JSX.Element => (
  <Box paddingX={spacing.indent}>
    <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? glyphs.actionCursor : ' '} </Text>
    <Text color={checked ? inkColors.success : inkColors.muted}>[{checked ? glyphs.check : ' '}]</Text>
    <Box width={GROUP_WIDTH} marginLeft={1} flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        {firstOfGroup ? GROUP_LABELS[row.candidate.kind] : ''}
      </Text>
    </Box>
    <Box flexGrow={1} flexShrink={1}>
      <Text bold={focused} wrap="truncate-end">
        {row.name} <Text dimColor>{row.detail}</Text>
      </Text>
    </Box>
    <Box width={SIZE_WIDTH} justifyContent="flex-end" flexShrink={0}>
      <Text dimColor>{formatBytes(row.candidate.bytes)}</Text>
    </Box>
  </Box>
);

const Summary = ({ scan }: { readonly scan: HousekeepingScan }): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Text wrap="truncate-end">
      <Text bold>{formatBytes(scan.reclaimableBytes)}</Text> reclaimable {glyphs.bullet} runs on disk:{' '}
      {plural(scan.runTotals.count, 'run')} ({formatBytes(scan.runTotals.bytes)})
    </Text>
    <Text dimColor wrap="truncate-end">
      Dry run {glyphs.emDash} nothing is deleted until you confirm. Old = done or started over{' '}
      {plural(scan.staleAfterDays, 'day')} ago.
    </Text>
  </Box>
);

const useHousekeepingKeys = (args: {
  readonly active: boolean;
  readonly hasRows: boolean;
  readonly toggle: () => void;
  readonly selectAll: () => void;
  readonly clear: () => void;
  readonly rescan: () => void;
}): void => {
  useViewKeys(
    [
      listMoveBinding,
      { keys: ['space'], hint: 'select', enabled: args.hasRows, run: args.toggle },
      { keys: ['a'], hint: 'all', enabled: args.hasRows, run: args.selectAll },
      { keys: ['c'], hint: 'clear', hidden: true, run: args.clear },
      { keys: ['↵'], hint: 'delete selected', enabled: args.hasRows },
      { keys: ['r'], hint: 'rescan', run: args.rescan },
    ],
    { active: args.active }
  );
};

const purgeNote = (report: HousekeepingPurgeReport): StructuredFeedback => {
  const { removed, skipped, failed, freedBytes } = report;
  const extra = [
    skipped.length > 0 ? `${String(skipped.length)} skipped (no longer eligible)` : '',
    failed.length > 0 ? `${String(failed.length)} failed` : '',
  ].filter((s) => s !== '');
  const tail = extra.length > 0 ? ` ${glyphs.bullet} ${extra.join(` ${glyphs.bullet} `)}` : '';
  return feedback(
    failed.length > 0 ? 'error' : 'success',
    `removed ${plural(removed.length, 'item')}, freed ${formatBytes(freedBytes)}${tail}`
  );
};

const CandidateList = ({
  rows,
  list,
  picked,
  totals,
}: {
  readonly rows: readonly HousekeepingRow[];
  readonly list: UseListWindowResult<HousekeepingRow>;
  readonly picked: ReadonlySet<string>;
  readonly totals: { readonly count: number; readonly bytes: number };
}): React.JSX.Element => (
  <>
    <Box flexDirection="column" marginTop={spacing.section}>
      <OverflowRow direction="above" count={list.window.hiddenAbove} />
      {list.visibleItems.map((row, i) => {
        const abs = list.window.start + i;
        return (
          <Row
            key={row.key}
            row={row}
            focused={abs === list.focusedIndex}
            checked={picked.has(row.key)}
            firstOfGroup={rows[abs - 1]?.candidate.kind !== row.candidate.kind}
          />
        );
      })}
      <OverflowRow direction="below" count={list.window.hiddenBelow} />
    </Box>
    <Box paddingX={spacing.indent} marginTop={spacing.section}>
      <Text dimColor>
        {glyphs.bullet} {String(totals.count)} of {String(rows.length)} selected
        {totals.count > 0 ? ` (${formatBytes(totals.bytes)})` : ''}
      </Text>
    </Box>
  </>
);

const useHousekeepingModel = () => {
  const deps = useDeps();
  const ui = useUiState();
  const { rows: termRows } = useBreakpoint();
  const mountedRef = useIsMounted();

  const { state, reload } = useAsyncLoad<HousekeepingScan>(async () => {
    const r = await deps.housekeeping.scan();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }, [deps.housekeeping]);

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<StructuredFeedback | undefined>(undefined);

  const rows = state.kind === 'ok' ? buildHousekeepingRows(state.value) : [];
  const listActive = !ui.modalOpen && !confirming;
  const list = useListWindow<HousekeepingRow>({
    items: rows,
    getId: (r) => r.key,
    visibleRows: listCapacity(termRows, { chromeRows: CHROME_ROWS, min: 4 }),
    active: listActive,
    onSubmit: () => {
      if (picked.size === 0) setNote(feedback('warning', 'nothing selected — press space to mark rows'));
      else {
        setNote(undefined);
        setConfirming(true);
      }
    },
  });

  const totals = selectionTotals(rows, picked);
  const selected = rows.filter((r) => picked.has(r.key)).map((r) => r.candidate);

  useHousekeepingKeys({
    active: listActive,
    hasRows: rows.length > 0,
    toggle: () => {
      const key = list.focusedItem?.key;
      if (key === undefined) return;
      setNote(undefined);
      setPicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    selectAll: () => setPicked(new Set(rows.map((r) => r.key))),
    clear: () => setPicked(new Set()),
    rescan: () => {
      setPicked(new Set());
      setNote(undefined);
      reload();
    },
  });

  const purge = async (): Promise<void> => {
    setConfirming(false);
    const r = await deps.housekeeping.purge(selected);
    if (!mountedRef.current) return;
    setPicked(new Set());
    setNote(purgeNote(r.value));
    reload();
  };

  return { state, rows, list, picked, totals, selected, confirming, setConfirming, note, purge };
};

export const HousekeepingView = (): React.JSX.Element => {
  const { state, rows, list, picked, totals, selected, confirming, setConfirming, note, purge } =
    useHousekeepingModel();

  const overlay = confirming ? (
    <ConfirmCard
      verb="Delete"
      target={`${plural(selected.length, 'item')} (${formatBytes(totals.bytes)})`}
      body={<Text dimColor>{groupCounts(selected).join(` ${glyphs.bullet} `)}. This cannot be undone.</Text>}
      onSubmit={(yes) => (yes ? void purge() : setConfirming(false))}
      onCancel={() => setConfirming(false)}
    />
  ) : undefined;

  return (
    <ViewShell title="Housekeeping" subtitle="reclaimable data" suppressScrollArrows>
      <AsyncListFrame
        {...(overlay !== undefined ? { overlay } : {})}
        state={state}
        loadingLabel="Scanning data…"
        errorMessage="Could not scan the data directory. Press r to retry."
        isEmpty={rows.length === 0}
        empty={
          <Box flexDirection="column">
            <EmptyState
              title="Nothing to reclaim"
              hint="No orphan sprints or memory, and nothing older than the threshold."
              action={`r ${glyphs.arrowRight} rescan  ${glyphs.bullet}  esc ${glyphs.arrowRight} back`}
            />
            <FeedbackLine text={note} />
          </Box>
        }
      >
        <Box flexDirection="column">
          {state.kind === 'ok' && <Summary scan={state.value} />}
          <CandidateList rows={rows} list={list} picked={picked} totals={totals} />
          <FeedbackLine text={note} />
        </Box>
      </AsyncListFrame>
    </ViewShell>
  );
};
