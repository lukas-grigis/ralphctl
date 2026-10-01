/**
 * Frame every view shares — four explicit zones under the app chrome that `Layout` owns (tab bar,
 * location line and rule sit ABOVE this component):
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ HEADER  (fixed; empty except Work's wordmark)│   ← full banner, only when it fits
 *   ├─────────────────────────────────────────────┤
 *   │ CONTENT (scrolls when it overflows the      │   ← page body inside a ScrollRegion
 *   │          viewport; clipped at the edges)    │
 *   ├─────────────────────────────────────────────┤
 *   │ STATUS  (fixed; collapses when no banner)   │   ← dismissible StatusBanner stack
 *   ├─────────────────────────────────────────────┤
 *   │ PROMPT  (fixed; collapses when no prompt)   │   ← modal Question card from PromptHost
 *   ├─────────────────────────────────────────────┤
 *   │ FOOTER  (fixed, never scrolls, never shrinks)│   ← rule + one hint row
 *   └─────────────────────────────────────────────┘
 *
 * The title row is gone from the body: `title` / `subtitle` / `right` are PUBLISHED to the
 * location line (`view-title-context.tsx`), which shows `▣ Section › crumb — subtitle` once for
 * the whole frame instead of every view stamping its own.
 *
 * The fixed zones are wrapped in their own `flexShrink={0}` boxes — without that, Yoga is
 * free to compress them when the inner content is taller than the terminal, which is exactly
 * what we want to avoid (a "fixed footer" that disappears when content overflows isn't fixed).
 *
 * The prompt slot pins the queued Question card above the footer so the keyboard hints stay
 * visible while the user answers. The PromptHost returns null when the queue is empty so this
 * row collapses to zero height between prompts.
 *
 * The status slot sits between content and the prompt so the dismissible banner stack lands
 * next to the other footer-adjacent surfaces (PromptHost, StatusBar). StatusBanner returns null
 * when no banners are active, so this row collapses too.
 *
 * The wordmark `'full'` banner is reserved for the Work root and only when it fits
 * (`resolveBannerMode`); everywhere else the header zone is empty and the tab bar's `ralphctl`
 * text is the only brand.
 */

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
   * Overrides the last location crumb when the route label is not the view's name (Execute shows
   * the flow it is running). Detail routes label themselves from route props instead.
   */
  readonly crumb?: string;
  /**
   * When true, the inner {@link ScrollRegion} ignores arrow / paging / vim scroll keys so a view
   * that owns its own list cursor handles them itself (no double-scroll). Mouse-wheel scroll is
   * unaffected. Default `undefined` / false — every current caller keeps the page-scroll keys.
   */
  readonly suppressScrollArrows?: boolean;
  /**
   * Result of the last action the operator took in this view (`✓ unblocked "…"`, `✗ <error>`),
   * rendered in the PINNED status row rather than inside the scroll body.
   *
   * Pinned because the scroll body is not a place a one-shot message can be trusted to land: on
   * a view tall enough to overflow, an inline result line sits wherever its section happens to
   * fall, which on a default-height terminal is below the fold — so the operator performs an
   * action and sees nothing. Views that overflow (sprint detail) pass their feedback here; short
   * list views that render {@link FeedbackLine} inline are unaffected.
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
