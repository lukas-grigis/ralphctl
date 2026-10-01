/**
 * System hub — the fifth section's root: Settings, Skills and Doctor (Housekeeping joins later),
 * one row each with a live one-line summary, so the operator sees what needs attention before
 * opening anything. `↵` pushes the child onto the System stack; `esc` in the child returns here.
 *
 * Summaries come from the shared sources the children use: the doctor report from
 * `useSystemStatus` (also feeding the tab-bar badge), `settingsRepo.load()` and
 * `skillCatalog.list()`. `r` reloads all of them. Ordering and copy live in
 * `system-view-model.ts`.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { WindowedList } from '@src/application/ui/tui/components/windowed-list.tsx';
import { glyphs, inkColors, listCapacity, spacing, tones } from '@src/application/ui/tui/theme/tokens.ts';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useAsyncLoad } from '@src/application/ui/tui/runtime/use-async-load.ts';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import { useBreakpoint } from '@src/application/ui/tui/runtime/use-breakpoint.ts';
import { listMoveBinding } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { buildSystemRows, type SummaryTone, type SystemRow } from '@src/application/ui/tui/views/system-view-model.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import type { SkillCatalogEntry } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';

/** Rows the frame spends outside the list: chrome (3), footer (2), padding. */
const CHROME_ROWS = 8;
const LABEL_WIDTH = 14;

interface Summaries {
  readonly settings: Settings | undefined;
  readonly skills: readonly SkillCatalogEntry[] | undefined;
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
      <Text color={focused ? inkColors.primary : inkColors.rule}>{focused ? glyphs.actionCursor : ' '}</Text>
      <Text bold={focused} {...(focused ? { color: inkColors.primary } : {})}>
        {' '}
        {row.label.padEnd(LABEL_WIDTH)}
      </Text>
      <Text wrap="truncate-end" {...(color !== undefined ? { color } : { dimColor: true })}>
        {row.summary}
      </Text>
    </Box>
  );
};

export const SystemView = (): React.JSX.Element => {
  const deps = useDeps();
  const router = useRouter();
  const ui = useUiState();
  const system = useSystemStatus();
  const { rows: termRows } = useBreakpoint();

  const { state, reload } = useAsyncLoad<Summaries>(async () => {
    const [settingsR, skillsR] = await Promise.all([deps.settingsRepo.load(), deps.skillCatalog.list()]);
    return {
      settings: settingsR.ok ? settingsR.value : undefined,
      skills: skillsR.ok ? skillsR.value : undefined,
    };
  }, [deps.settingsRepo, deps.skillCatalog]);

  const summaries: Summaries = state.kind === 'ok' ? state.value : { settings: undefined, skills: undefined };
  const rows = useMemo(
    () =>
      buildSystemRows({
        report: system.doctor,
        doctorLoading: system.doctorLoading,
        settings: summaries.settings,
        skills: summaries.skills,
      }),
    [system.doctor, system.doctorLoading, summaries.settings, summaries.skills]
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
          onSubmit={(r) => router.push({ id: r.view })}
          renderItem={(r, focused) => <Row row={r} focused={focused} />}
        />
      </Box>
    </ViewShell>
  );
};
