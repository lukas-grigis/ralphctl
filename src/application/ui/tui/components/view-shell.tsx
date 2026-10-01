/** Frame every view shares — four explicit zones under the app chrome that `Layout` owns (tab bar. */

import React from 'react';
import { Box } from 'ink';
import { Banner, resolveBannerMode } from '@src/application/ui/tui/components/banner.tsx';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
import { StatusBanner } from '@src/application/ui/tui/components/status-banner.tsx';
import { FeedbackLine, type StructuredFeedback } from '@src/application/ui/tui/components/feedback-line.tsx';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { usePromptQueue } from '@src/application/ui/tui/prompts/prompt-context.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { usePublishViewTitle } from '@src/application/ui/tui/runtime/view-title-context.tsx';

export interface ViewShellProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Rendered on the location line after the title — Execute's status chip. */
  readonly right?: React.ReactNode;
  /** Cells `right` needs, so the location line can budget for it. */
  readonly rightWidth?: number;
  /**
   * Overrides the last location crumb when the route label is not the view's name (Execute shows the flow it is
   * running).
   */
  readonly crumb?: string;
  /**
   * When true, the inner {@link ScrollRegion} ignores arrow / paging / vim scroll keys so a view that owns its own
   * list cursor handles them itself (no double-scroll).
   */
  readonly suppressScrollArrows?: boolean;
  /**
   * Result of the last action the operator took in this view (`✓ unblocked "…"`, `✗ <error>`), rendered in the PINNED
   * status row rather than inside the scroll body.
   */
  readonly feedback?: string | StructuredFeedback;
  readonly children: React.ReactNode;
}

export const ViewShell = ({
  title,
  subtitle,
  right,
  rightWidth,
  crumb,
  suppressScrollArrows,
  feedback,
  children,
}: ViewShellProps): React.JSX.Element => {
  usePublishViewTitle({ title, subtitle, crumb, right, rightWidth });
  const ui = useUiState();
  const queue = usePromptQueue();
  const router = useRouter();
  const { columns, rows } = useTerminalSize();
  const bannerMode = resolveBannerMode({
    routeId: router.current.id,
    columns,
    rows,
    userToggle: ui.bannerCompact,
  });
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* ── HEADER ─────────────────────────────────────────────────────────────────────── */}
      <Box flexDirection="column" flexShrink={0}>
        <Banner mode={bannerMode} />
      </Box>

      {/* ── CONTENT ────────────────────────────────────────────────────────────────────── */}
      <ScrollRegion disabled={ui.modalOpen} suppressArrows={suppressScrollArrows ?? false}>
        {children}
      </ScrollRegion>

      {/* ── STATUS ─────────────────────────────────────────────────────────────────────── */}
      {/* Dismissible banner stack — sits above the prompt so it lands next to the other
          footer-adjacent surfaces (the keyboard hint `press d to dismiss` is closer to the
          footer hotkey rail), and collapses to zero height when nothing is published. */}
      <Box flexDirection="column" flexShrink={0}>
        <FeedbackLine text={feedback} />
        <StatusBanner />
      </Box>

      {/* ── PROMPT ─────────────────────────────────────────────────────────────────────── */}
      {/* Sits above the footer so the modal isn't pushed off the bottom of the screen.
          The host renders null when the queue is empty, so this slot collapses. */}
      <Box flexDirection="column" flexShrink={0}>
        <PromptHost queue={queue} />
      </Box>

      {/* ── FOOTER ─────────────────────────────────────────────────────────────────────── */}
      <Box flexDirection="column" flexShrink={0}>
        <StatusBar />
      </Box>
    </Box>
  );
};
