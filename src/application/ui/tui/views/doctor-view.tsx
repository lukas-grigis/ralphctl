/**
 * Doctor view — sanity probes the operator can run when something feels off. Probes execute
 * via the `doctor` use-case so the TUI and `ralphctl doctor` CLI report the same data.
 *
 * Probes are bucketed by their `group` field and rendered under section headers. Probes
 * without a group fall under a "General" section.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useStorage } from '@src/application/ui/tui/runtime/storage-context.tsx';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { HelpOverlay } from '@src/application/ui/tui/components/help-overlay.tsx';
import { createDoctorFlow } from '@src/application/flows/doctor/flow.ts';
import type { ProbeGroup, ProbeResult } from '@src/application/flows/doctor/ctx.ts';
import { commandExists } from '@src/integration/io/command-exists.ts';
import { runCommand } from '@src/integration/io/run-command.ts';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

const GROUP_ORDER: ReadonlyArray<ProbeGroup | 'other'> = [
  'storage',
  'settings',
  'runtime',
  'vcs',
  'ai',
  'repositories',
  'integrity',
  'other',
];

const GROUP_LABEL: Record<ProbeGroup | 'other', string> = {
  storage: 'Storage',
  settings: 'Settings',
  runtime: 'Runtime',
  vcs: 'Version control',
  ai: 'AI providers',
  repositories: 'Repositories',
  integrity: 'Data integrity',
  other: 'Other',
};

export const DoctorView = (): React.JSX.Element => {
  const deps = useDeps();
  const storage = useStorage();
  const ui = useUiState();
  const [results, setResults] = useState<readonly ProbeResult[] | undefined>(undefined);
  useViewHints([{ keys: 'r', label: 'reload' }]);

  const runProbes = useCallback(async (): Promise<void> => {
    setResults(undefined);
    const flow = createDoctorFlow({
      projectRepo: deps.projectRepo,
      sprintRepo: deps.sprintRepo,
      sprintExecutionRepo: deps.sprintExecutionRepo,
      settingsRepo: deps.settingsRepo,
      commandExists,
      runCommand,
      nodeVersion: process.version,
    });
    const report = await flow.execute({
      input: { dataRoot: storage.dataRoot, configRoot: storage.configRoot },
    });
    if (report.ok) setResults(report.value.ctx.output!.probes);
  }, [deps, storage]);

  useEffect(() => {
    void runProbes();
  }, [runProbes]);

  useInput((input) => {
    if (ui.helpOpen || ui.promptActive) return;
    if (input === 'r') void runProbes();
  });

  return (
    <ViewShell title="Doctor" subtitle="sanity probes">
      {ui.helpOpen ? (
        <HelpOverlay />
      ) : results === undefined ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Running probes…" />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SummaryHeader probes={results} />
          {GROUP_ORDER.map((group) => {
            const entries = results.filter((r) => (r.group ?? 'other') === group);
            if (entries.length === 0) return null;
            return (
              <Box key={group} flexDirection="column" marginBottom={spacing.section}>
                <Box paddingX={spacing.indent}>
                  <Text bold>
                    {glyphs.badge} {GROUP_LABEL[group]}
                  </Text>
                </Box>
                {entries.map((r) => (
                  <ProbeRow key={r.id} probe={r} />
                ))}
              </Box>
            );
          })}
        </Box>
      )}
    </ViewShell>
  );
};

/**
 * Renders a one-line tally above the grouped probe list so users get the verdict at a glance
 * without scanning every section. Color of the leading icon reflects the worst category
 * present: red if any fail, yellow if any warn, green when everything passes.
 */
const SummaryHeader = ({ probes }: { readonly probes: readonly ProbeResult[] }): React.JSX.Element => {
  const passes = probes.filter((p) => p.status === 'pass').length;
  const warnings = probes.filter((p) => p.status === 'warn').length;
  const failures = probes.filter((p) => p.status === 'fail').length;
  const tone = failures > 0 ? inkColors.error : warnings > 0 ? inkColors.warning : inkColors.primary;
  const icon = failures > 0 ? '✗' : warnings > 0 ? '!' : '✓';
  return (
    <Box paddingX={spacing.indent} marginBottom={spacing.section}>
      <Text color={tone} bold>
        {icon} {String(passes)} passed
      </Text>
      <Text dimColor>
        {' '}
        {glyphs.bullet} {String(warnings)} warning{warnings === 1 ? '' : 's'} {glyphs.bullet} {String(failures)} failure
        {failures === 1 ? '' : 's'} {glyphs.bullet} r reload
      </Text>
    </Box>
  );
};

const ProbeRow = ({ probe }: { readonly probe: ProbeResult }): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Box>
      <StatusChip
        label={probe.status}
        kind={probe.status === 'pass' ? 'success' : probe.status === 'fail' ? 'error' : 'warning'}
      />
      <Text> {probe.label}</Text>
    </Box>
    {probe.detail !== undefined && (
      <Box paddingLeft={2}>
        <Text dimColor>
          {glyphs.activityArrow} {probe.detail}
        </Text>
      </Box>
    )}
    {probe.hint !== undefined && probe.status !== 'pass' && (
      <Box paddingLeft={2}>
        <Text dimColor italic>
          hint: {probe.hint}
        </Text>
      </Box>
    )}
  </Box>
);
