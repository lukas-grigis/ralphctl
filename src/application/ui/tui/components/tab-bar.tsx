/**
 * Tab bar — row 0 of every frame. The five persistent sections (`1 Work`, `2 Sprints`,
 * `3 Projects`, `4 Runs`, `5 System`) with live badges, plus `? help` on the right. The layout is
 * computed by {@link layoutTabs}; this component only paints it.
 *
 * Hidden while no section is active (the first-run wizard). Badges read the session list and the
 * shared system status, so a run starting or a doctor probe degrading shows up on every screen
 * without a view wiring it.
 */

import React from 'react';
import { Text } from 'ink';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { layoutTabs, type TabTone } from '@src/application/ui/tui/components/tab-bar-layout.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

const toneProps = (
  tone: TabTone
): { readonly color?: string; readonly bold?: boolean; readonly dimColor?: boolean } => {
  switch (tone) {
    case 'brand':
      return { color: inkColors.primary, bold: true };
    case 'active':
      return { color: inkColors.primary, bold: true };
    case 'live':
      return { color: inkColors.info, bold: true };
    case 'warn':
      return { color: inkColors.warning, bold: true };
    case 'fail':
      return { color: inkColors.error, bold: true };
    case 'update':
      return { color: inkColors.highlight };
    case 'dim':
    case 'tab':
      return { dimColor: true };
  }
};

export const TabBar = (): React.JSX.Element | null => {
  const router = useRouter();
  const sessions = useSessions();
  const system = useSystemStatus();
  const { columns } = useTerminalSize();
  if (router.activeSection === 'none') return null;

  const probes = system.doctor?.probes ?? [];
  const layout = layoutTabs({
    columns,
    active: router.activeSection,
    badges: {
      runsLive: sessions.filter((s) => s.descriptor.status === 'running').length,
      doctorWarn: probes.filter((p) => p.status === 'warn').length,
      doctorFail: probes.filter((p) => p.status === 'fail').length,
    },
    version: CLI_METADATA.currentVersion,
    latest: system.version?.updateAvailable === true ? system.version.latest : undefined,
  });

  return (
    <Text wrap="truncate-end">
      {layout.segments.map((seg, i) => (
        <Text key={`${String(i)}-${seg.text}`} {...toneProps(seg.tone)}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
};
