/**
 * Doctor view — sanity probes the operator can run when something feels off. Probes execute
 * via the `doctor` use-case so the TUI and `ralphctl doctor` CLI report the same data.
 *
 * Probes are bucketed by their `group` field and rendered under section headers. Probes
 * without a group fall under a "General" section.
 *
 * The view reads the doctor report from {@link useSystemStatus} so the StatusBar footer and
 * the view share a single source of truth — pressing `r` here also refreshes the footer's
 * "X doctor warnings" indicator.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { StatusChip } from '@src/application/ui/tui/components/status-chip.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { useViewKeys } from '@src/application/ui/tui/runtime/use-view-keys.ts';
import type { ProbeGroup, ProbeResult } from '@src/application/flows/doctor/ctx.ts';

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

const SEVERITY: Readonly<Record<ProbeResult['status'], number>> = { fail: 0, warn: 1, unknown: 2, pass: 3 };

interface GroupBucket {
  readonly group: ProbeGroup | 'other';
  /** Probes in severity order, worst first — the thing the operator came here to read. */
  readonly probes: readonly ProbeResult[];
  readonly worst: number;
}

/**
 * Bucket probes by group and order the buckets worst-first (fail, warn, unknown, pass), keeping
 * {@link GROUP_ORDER} as the tiebreak. Healthy groups sort last so the rows that need action are
 * reachable without scrolling past dozens of passes.
 */
const bucketProbes = (results: readonly ProbeResult[]): readonly GroupBucket[] =>
  GROUP_ORDER.flatMap((group): GroupBucket[] => {
    const probes = results
      .filter((r) => (r.group ?? 'other') === group)
      .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
    const first = probes[0];
    return first === undefined ? [] : [{ group, probes, worst: SEVERITY[first.status] }];
  }).sort((a, b) => a.worst - b.worst);

export const DoctorView = (): React.JSX.Element => {
  const system = useSystemStatus();
  const results = system.doctor?.probes;
  const [showPassed, setShowPassed] = useState(false);
  const buckets = useMemo(() => bucketProbes(results ?? []), [results]);
  const healthy = buckets.filter((b) => b.worst === SEVERITY.pass);
  const attention = buckets.filter((b) => b.worst !== SEVERITY.pass);
  const healthyCount = healthy.reduce((n, b) => n + b.probes.length, 0);
  useViewKeys([
    {
      keys: ['↵'],
      hint: showPassed ? 'hide passed' : 'show passed',
      enabled: healthyCount > 0,
      run: () => setShowPassed((v) => !v),
    },
    { keys: ['r'], hint: 'reload', run: () => void system.refreshDoctor() },
  ]);

  // Trigger a refresh on first mount when the shared provider hasn't auto-fired yet (e.g. the
  // test-env gate suppressed the boot-time probe). A ref guards against re-firing if the
  // refreshDoctor callback identity changes mid-life. Explicit re-runs go through the `r`
  // keybind below.
  const refreshDoctor = system.refreshDoctor;
  const triggered = React.useRef(false);
  useEffect(() => {
    if (triggered.current) return;
    if (results !== undefined || system.doctorLoading) return;
    triggered.current = true;
    void refreshDoctor();
  }, [refreshDoctor, results, system.doctorLoading]);

  const showSpinner = system.doctorLoading || results === undefined;

  return (
    <ViewShell title="Doctor" subtitle="sanity probes">
      {showSpinner ? (
        <Box paddingX={spacing.indent}>
          <Spinner label="Running probes…" />
        </Box>
      ) : (
        <Box flexDirection="column">
          <SummaryHeader probes={results} />
          {attention.map((bucket) => (
            <GroupSection key={bucket.group} bucket={bucket} />
          ))}
          {healthyCount > 0 && (
            <Box paddingX={spacing.indent} marginBottom={spacing.section}>
              <Text color={inkColors.primary}>
                {glyphs.check} {String(healthyCount)} passed
              </Text>
            </Box>
          )}
          {showPassed && healthy.map((bucket) => <GroupSection key={bucket.group} bucket={bucket} />)}
        </Box>
      )}
    </ViewShell>
  );
};

const GroupSection = ({ bucket }: { readonly bucket: GroupBucket }): React.JSX.Element => (
  <Box flexDirection="column" marginBottom={spacing.section}>
    <Box paddingX={spacing.indent}>
      <Text bold>
        {glyphs.badge} {GROUP_LABEL[bucket.group]}
      </Text>
    </Box>
    {bucket.probes.map((r) => (
      <ProbeRow key={r.id} probe={r} />
    ))}
  </Box>
);

/**
 * Renders a one-line tally above the grouped probe list so users get the verdict at a glance
 * without scanning every section. Color of the leading icon reflects the worst category
 * present: red if any fail, yellow if any warn, green when everything passes.
 */
const SummaryHeader = ({ probes }: { readonly probes: readonly ProbeResult[] }): React.JSX.Element => {
  const warnings = probes.filter((p) => p.status === 'warn').length;
  const failures = probes.filter((p) => p.status === 'fail').length;
  const unknowns = probes.filter((p) => p.status === 'unknown').length;
  const tone = failures > 0 ? inkColors.error : warnings > 0 ? inkColors.warning : inkColors.primary;
  const icon = failures > 0 ? glyphs.cross : warnings > 0 ? glyphs.warningGlyph : glyphs.check;
  return (
    <Box paddingX={spacing.indent} marginBottom={spacing.section}>
      <Text color={tone} bold>
        {icon}
      </Text>
      <Text dimColor>
        {' '}
        {String(warnings)} warning{warnings === 1 ? '' : 's'} {glyphs.bullet} {String(failures)} failure
        {failures === 1 ? '' : 's'} {glyphs.bullet} {String(unknowns)} unknown
      </Text>
    </Box>
  );
};

const ProbeRow = ({ probe }: { readonly probe: ProbeResult }): React.JSX.Element => (
  <Box flexDirection="column" paddingX={spacing.indent}>
    <Box>
      <StatusChip
        label={probe.status}
        kind={
          probe.status === 'pass'
            ? 'success'
            : probe.status === 'fail'
              ? 'error'
              : probe.status === 'unknown'
                ? 'muted'
                : 'warning'
        }
      />
      <Text> {probe.label}</Text>
    </Box>
    {probe.detail !== undefined && (
      <Box paddingLeft={spacing.indent}>
        <Text dimColor>
          {glyphs.activityArrow} {probe.detail}
        </Text>
      </Box>
    )}
    {probe.hint !== undefined && probe.status !== 'pass' && (
      <Box paddingLeft={spacing.indent}>
        <Text dimColor italic>
          hint: {probe.hint}
        </Text>
      </Box>
    )}
  </Box>
);
