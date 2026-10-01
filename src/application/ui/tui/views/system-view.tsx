/**
 * System hub — the fifth section's root: Settings, Skills, Doctor and Housekeeping, one row each with a live one-line
 * summary, so the operator sees what needs attention before opening anything.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { WindowedList } from '@src/application/ui/tui/components/windowed-list.tsx';
import { glyphs, inkColors, listCapacity, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter, useViewProps } from '@src/application/ui/tui/runtime/router.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { buildSystemRows, type SummaryTone, type SystemRow } from '@src/application/ui/tui/views/system-view-model.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { HousekeepingScan } from '@src/business/housekeeping/scan-housekeeping.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';

/** Rows the frame spends outside the list: chrome (3), footer (2), padding. */
const CHROME_ROWS = 8;
const LABEL_WIDTH = 14;

interface Summaries {
  readonly settings: Settings | undefined;
  readonly skills: readonly SkillCatalogEntry[] | undefined;
  readonly housekeeping: HousekeepingScan | undefined;
}

const SUMMARY_COLOR: Readonly<Record<SummaryTone, string | undefined>> = {
  ok: tones.success.color,
  warn: tones.warning.color,
  fail: tones.error.color,
  dim: undefined,
};

const Row = ({ row, focused }: { readonly row: SystemRow; readonly focused: boolean }): React.JSX.Element => {
  const color = SUMMARY_COLOR[row.tone];
  return (
    <Box paddingX={spacing.indent}>
      <Box flexShrink={0}>
        <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? glyphs.actionCursor : ' '}</Text>
        <Text wrap="truncate-end" bold={focused} {...(focused ? { color: inkColors.primary } : {})}>
          {' '}
          {row.label.padEnd(LABEL_WIDTH)}
        </Text>
      </Box>
      <Box flexShrink={1} flexGrow={1} minWidth={0}>
        <Text wrap="truncate-end" {...(color !== undefined ? { color } : { dimColor: true })}>
          {row.summary}
        </Text>
      </Box>
    </Box>
  );
};

export const SystemView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const system = useSystemStatus();
  const { rows: termRows } = useBreakpoint();
  const { returnedFrom } = useViewProps<{ readonly returnedFrom?: string }>();

  const { state, reload } = useAsyncLoad<Summaries>(async () => {
    const [settingsR, skillsR, housekeepingR] = await Promise.all([
      deps.settingsRepo.load(),
      deps.skillCatalog.list(),
      deps.housekeeping.scan(),
    ]);
    return {
      settings: settingsR.ok ? settingsR.value : undefined,
      skills: skillsR.ok ? skillsR.value : undefined,
      housekeeping: housekeepingR.ok ? housekeepingR.value : undefined,
    };
  }, [deps.settingsRepo, deps.skillCatalog, deps.housekeeping]);

  const summariesLoading = state.kind === 'idle' || state.kind === 'loading';
  const summaries: Summaries =
    state.kind === 'ok' ? state.value : { settings: undefined, skills: undefined, housekeeping: undefined };
  const rows = useMemo(
    () =>
      buildSystemRows({
        report: system.doctor,
        doctorLoading: system.doctorLoading,
        summariesLoading,
        settings: summaries.settings,
        skills: summaries.skills,
        housekeeping: summaries.housekeeping,
      }),
    [
      system.doctor,
      system.doctorLoading,
      summariesLoading,
      summaries.settings,
      summaries.skills,
      summaries.housekeeping,
    ]
  );

  const refreshDoctor = system.refreshDoctor;
  useViewKeys(
    [
      listMoveBinding,
      { keys: ['↵'], hint: 'open' },
      {
        keys: ['r'],
        hint: 'reload',
        run: () => {
          void refreshDoctor();
          reload();
        },
      },
    ],
    { active: !ui.modalOpen }
  );

  return (
    <ViewShell title="System" subtitle="health, configuration and cleanup" suppressScrollArrows>
      <Box flexDirection="column" marginTop={spacing.section}>
        <WindowedList<SystemRow>
          items={rows}
          getId={(r) => r.id}
          visibleRows={listCapacity(termRows, { chromeRows: CHROME_ROWS, min: 4 })}
          active={!ui.modalOpen}
          initialCursorId={rows.find((r) => r.view === returnedFrom)?.id}
          onSubmit={(r) => router.push({ id: r.view })}
          renderItem={(r, focused) => <Row row={r} focused={focused} />}
        />
      </Box>
    </ViewShell>
  );
};
